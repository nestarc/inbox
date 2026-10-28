import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const exampleRequire = createRequire(
  new URL("../examples/package.json", import.meta.url),
);
const {
  InboxService,
  InboxBackpressureError,
  InboxConflictError,
} = require("../dist");
const { PrismaClient } = require("../test/prisma/generated");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
let amqp;
try {
  amqp = exampleRequire("amqplib");
} catch {
  throw new Error(
    "Install the example dependencies first: npm install --prefix examples",
  );
}

// This harness never accepts an application database or an existing broker.
const databaseUrl = process.env.INBOX_TEST_DATABASE_URL;
const databaseName = process.env.INBOX_TEST_DATABASE_NAME;
if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  !databaseUrl ||
  process.env.DATABASE_URL !== databaseUrl ||
  !/^nestarc_inbox_test_[0-9a-f]{16}$/.test(databaseName ?? "")
)
  throw new Error("Run through scripts/with-test-db.mjs.");
const parsed = new URL(databaseUrl);
assert.equal(parsed.protocol, "postgresql:");
assert.equal(parsed.hostname, "127.0.0.1");
assert.equal(parsed.username, "inbox_test");
assert.equal(parsed.pathname, `/${databaseName}`);
assert.ok(parsed.port && !parsed.search && !parsed.hash);

const execute = promisify(execFile);
const suffix = randomBytes(8).toString("hex");
const name = `nestarc-inbox-broker-recovery-${suffix}`;
const volume = `${name}-data`;
const username = `inbox_${suffix}`;
const password = randomBytes(24).toString("hex");
const consumer = "broker.recovery.v1";
const queue = `${name}.main`;
const retryQueue = `${name}.retry`;
const deadQueue = `${name}.dead`;
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl, max: 8 }),
});
let containerId;
let volumeCreated = false;
let brokerUrl;
let connection;
let channel;
let inbox;
let interrupted;
let restartCount = 0;
const results = [];
const started = Date.now();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
  });
}
function checkSignal() {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
}
async function docker(args, timeout = 90_000) {
  const { stdout } = await execute("docker", args, {
    cwd: root,
    timeout,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}
async function until(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkSignal();
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}
async function connect() {
  await until(
    async () => {
      try {
        connection = await amqp.connect(brokerUrl, { timeout: 1000 });
        connection.on("error", () => {}); // Expected during deliberate SIGKILL.
        channel = await connection.createConfirmChannel();
        channel.on("error", () => {});
        return true;
      } catch {
        await connection?.close().catch(() => {});
        connection = undefined;
        return false;
      }
    },
    "RabbitMQ ready after start",
    90_000,
  );
}
async function restart() {
  checkSignal();
  // SIGKILL, not graceful shutdown: durable queues must survive on the same volume.
  await docker(["kill", "--signal", "KILL", containerId]);
  connection = undefined;
  channel = undefined;
  await docker(["start", containerId]);
  await updateBrokerUrl();
  await connect();
  restartCount++;
}
async function updateBrokerUrl() {
  // Docker may allocate a different ephemeral host port when the container restarts.
  const binding = await docker(["port", containerId, "5672/tcp"]);
  const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
  assert.ok(port, "broker must bind only to loopback");
  brokerUrl = `amqp://${username}:${password}@127.0.0.1:${port}`;
}
function envelope(messageId, payload) {
  return {
    scope: { kind: "global" },
    source: "broker-recovery",
    consumer,
    messageId,
    eventType: "recovery.requested",
    schemaVersion: 1,
    payload,
  };
}
function makeInbox(maxPendingMessages) {
  return new InboxService({
    prisma,
    consumers: [consumer],
    maxPendingMessages,
    worker: {
      enabled: false,
      concurrency: 2,
      maxAttempts: 3,
      retryBaseMs: 20,
      retryMaxMs: 40,
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      transactionTimeoutMs: 2_000,
      transactionMaxWaitMs: 1_000,
      lockTimeoutMs: 500,
      shutdownTimeoutMs: 3_000,
    },
    handlers: [
      {
        consumer,
        eventType: "recovery.requested",
        schemaVersion: 1,
        async handle(payload, context) {
          // Every attempt writes before failing; zero effects after failure proves rollback.
          await context.tx.$executeRawUnsafe(
            "INSERT INTO public.inbox_broker_recovery_effect (id, inbox_id, message_id) VALUES ($1::uuid,$2::uuid,$3)",
            randomUUID(),
            context.inboxId,
            context.messageId,
          );
          if (
            payload.mode === "poison" ||
            (payload.mode === "transient" && context.attempt === 1)
          ) {
            throw new Error("Deliberate handler failure after business write");
          }
        },
      },
    ],
  });
}
async function publish(target, messageId, payload, headers = {}, expiration) {
  channel.sendToQueue(
    target,
    Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)),
    {
      persistent: true,
      messageId,
      contentType: "application/json",
      headers,
      ...(expiration === undefined ? {} : { expiration }),
    },
  );
  await channel.waitForConfirms();
}
async function delivery(target = queue) {
  return until(
    () => channel.get(target, { noAck: false }),
    `delivery from ${target}`,
  );
}
async function effects(messageId) {
  return Number(
    (
      await pool.query(
        "SELECT count(*) AS count FROM public.inbox_broker_recovery_effect WHERE message_id=$1",
        [messageId],
      )
    ).rows[0].count,
  );
}
async function drain(id, status) {
  return until(async () => {
    await inbox.runOnce();
    const record = await inbox.admin.forGlobal().get(id);
    return record.status === status ? record : false;
  }, `receipt ${id} reaches ${status}`);
}

try {
  await pool.query(
    await readFile(
      new URL("../src/sql/create-inbox-table.sql", import.meta.url),
      "utf8",
    ),
  );
  await pool.query(`CREATE TABLE public.inbox_broker_recovery_effect (
    id uuid PRIMARY KEY, inbox_id uuid NOT NULL, message_id text NOT NULL
  )`);
  inbox = makeInbox();
  await inbox.initialize();
  await docker([
    "volume",
    "create",
    "--label",
    "dev.nestarc.inbox.fixture=true",
    volume,
  ]);
  volumeCreated = true;
  containerId = await docker([
    "create",
    "--name",
    name,
    "--hostname",
    name,
    "--label",
    "dev.nestarc.inbox.fixture=true",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--publish",
    "127.0.0.1::5672",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/rabbitmq`,
    "--env",
    `RABBITMQ_DEFAULT_USER=${username}`,
    "--env",
    `RABBITMQ_DEFAULT_PASS=${password}`,
    "rabbitmq:4-alpine",
  ]);
  assert.match(containerId, /^[0-9a-f]{64}$/);
  await docker(["start", containerId]);
  await updateBrokerUrl();
  await connect();
  await channel.assertQueue(deadQueue, { durable: true });
  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": deadQueue,
    },
  });
  await channel.assertQueue(retryQueue, {
    durable: true,
    arguments: {
      "x-message-ttl": 10_000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": queue,
    },
  });

  const messageId = randomUUID();
  await publish(queue, messageId, { mode: "success" });
  const first = await delivery();
  assert.equal(first.fields.redelivered, false);
  const receipt = await inbox.accept(
    envelope(messageId, JSON.parse(first.content)),
  );
  await drain(receipt.id, "COMPLETED");
  assert.equal(await effects(messageId), 1);
  // No ACK: destroy the broker at exactly the committed-receipt / transport-ACK gap.
  await restart();
  const redelivery = await delivery();
  assert.equal(redelivery.properties.messageId, messageId);
  assert.equal(redelivery.fields.redelivered, true);
  const duplicate = await inbox.accept(
    envelope(messageId, JSON.parse(redelivery.content)),
  );
  assert.deepEqual(duplicate, {
    kind: "duplicate",
    id: receipt.id,
    status: "COMPLETED",
  });
  channel.ack(redelivery);
  await inbox.runOnce();
  assert.equal(await effects(messageId), 1);
  results.push({
    scenario: "SIGKILL after receipt commit before ACK",
    redelivered: true,
    receipt: "duplicate",
    committedEffects: 1,
  });

  await inbox.close();
  inbox = makeInbox(1);
  const blockerId = randomUUID();
  const blocker = await inbox.accept(envelope(blockerId, { mode: "success" }));
  const retryId = randomUUID();
  await publish(queue, retryId, { mode: "success" });
  const blocked = await delivery();
  await assert.rejects(
    inbox.accept(envelope(retryId, JSON.parse(blocked.content))),
    InboxBackpressureError,
  );
  // Transport retry owns the message only while accept() cannot commit.
  await publish(retryQueue, retryId, blocked.content, {
    "x-example-retries": 1,
  });
  channel.ack(blocked);
  assert.equal((await channel.checkQueue(retryQueue)).messageCount, 1);
  await restart();
  await drain(blocker.id, "COMPLETED");
  const retried = await delivery();
  assert.equal(retried.properties.messageId, retryId);
  assert.equal(retried.properties.headers["x-example-retries"], 1);
  assert.ok(
    retried.properties.headers["x-death"].some(
      (entry) => entry.queue === retryQueue && entry.reason === "expired",
    ),
  );
  const retryReceipt = await inbox.accept(
    envelope(retryId, JSON.parse(retried.content)),
  );
  channel.ack(retried);
  await drain(retryReceipt.id, "COMPLETED");
  assert.equal(await effects(retryId), 1);
  results.push({
    scenario:
      "admission failure, confirmed retry transfer, broker SIGKILL, TTL redelivery",
    transportRetries: 1,
    committedEffects: 1,
  });

  const exhaustedBlockerId = randomUUID();
  const exhaustedBlocker = await inbox.accept(
    envelope(exhaustedBlockerId, { mode: "success" }),
  );
  const exhaustedId = randomUUID();
  await publish(queue, exhaustedId, { mode: "success" });
  for (let attempt = 0; attempt <= 3; attempt++) {
    const item = await delivery();
    assert.equal(item.properties.messageId, exhaustedId);
    assert.equal(item.properties.headers["x-example-retries"] ?? 0, attempt);
    await assert.rejects(
      inbox.accept(envelope(exhaustedId, JSON.parse(item.content))),
      InboxBackpressureError,
    );
    if (attempt === 3) {
      channel.nack(item, false, false);
    } else {
      // Per-message TTL bounds this retry-budget test without changing queue policy.
      await publish(
        retryQueue,
        exhaustedId,
        item.content,
        { "x-example-retries": attempt + 1 },
        "100",
      );
      channel.ack(item);
    }
  }
  const exhausted = await delivery(deadQueue);
  assert.equal(exhausted.properties.messageId, exhaustedId);
  assert.equal(exhausted.properties.headers["x-example-retries"], 3);
  assert.ok(
    exhausted.properties.headers["x-death"].some(
      (entry) => entry.queue === queue && entry.reason === "rejected",
    ),
  );
  channel.ack(exhausted);
  assert.equal(await effects(exhaustedId), 0);
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) AS count FROM public.nestarc_inbox WHERE message_id=$1",
          [exhaustedId],
        )
      ).rows[0].count,
    ),
    0,
  );
  await drain(exhaustedBlocker.id, "COMPLETED");
  results.push({
    scenario:
      "persistent admission failure exhausts transport retry budget into DLQ",
    acceptanceFailures: 4,
    transportRetries: 3,
    committedReceipts: 0,
    committedEffects: 0,
  });

  const invalidId = randomUUID();
  await publish(queue, invalidId, Buffer.from("{invalid-json"));
  const invalid = await delivery();
  assert.throws(() => JSON.parse(invalid.content));
  channel.nack(invalid, false, false);
  await publish(queue, messageId, { mode: "changed-content" });
  const conflict = await delivery();
  await assert.rejects(
    inbox.accept(envelope(messageId, JSON.parse(conflict.content))),
    InboxConflictError,
  );
  channel.nack(conflict, false, false);
  const deadLetters = [];
  for (let index = 0; index < 2; index++) {
    const dead = await delivery(deadQueue);
    assert.ok(
      dead.properties.headers["x-death"].some(
        (entry) => entry.queue === queue && entry.reason === "rejected",
      ),
    );
    deadLetters.push(dead.properties.messageId);
    channel.ack(dead);
  }
  assert.deepEqual(deadLetters.sort(), [invalidId, messageId].sort());
  assert.equal(await effects(invalidId), 0);
  assert.equal(await effects(messageId), 1);
  results.push({
    scenario: "invalid JSON and identity conflict reach transport DLQ",
    deadLetters: 2,
    newCommittedEffects: 0,
  });

  await inbox.close();
  inbox = makeInbox();
  const transientId = randomUUID();
  const poisonId = randomUUID();
  const accepted = [];
  for (const [id, mode] of [
    [transientId, "transient"],
    [poisonId, "poison"],
  ]) {
    await publish(queue, id, { mode });
    const item = await delivery();
    accepted.push(await inbox.accept(envelope(id, JSON.parse(item.content))));
    channel.ack(item);
  }
  await inbox.runOnce();
  for (const item of accepted) {
    const record = await inbox.admin.forGlobal().get(item.id);
    assert.equal(record.status, "RETRYABLE");
    assert.equal(record.attemptCount, 1);
    assert.equal(await effects(record.messageId), 0);
  }
  await inbox.close();
  await restart();
  inbox = makeInbox();
  const successful = await drain(accepted[0].id, "COMPLETED");
  const dead = await drain(accepted[1].id, "DEAD");
  assert.equal(successful.attemptCount, 2);
  assert.equal(dead.attemptCount, 3);
  assert.equal(await effects(transientId), 1);
  assert.equal(await effects(poisonId), 0);
  assert.equal((await channel.checkQueue(queue)).messageCount, 0);
  assert.equal((await channel.checkQueue(retryQueue)).messageCount, 0);
  assert.equal((await channel.checkQueue(deadQueue)).messageCount, 0);
  results.push({
    scenario: "Inbox retry ownership survives broker and service restart",
    transientAttempts: 2,
    poisonAttempts: 3,
    committedEffects: { transient: 1, poison: 0 },
    poisonStatus: "DEAD",
  });
  const stats = await inbox.admin.forGlobal().stats();
  assert.equal(stats.counts.COMPLETED, 5);
  assert.equal(stats.counts.DEAD, 1);
  assert.equal(
    stats.counts.PENDING + stats.counts.PROCESSING + stats.counts.RETRYABLE,
    0,
  );
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        packageVersion: require("../package.json").version,
        brokerImage: "rabbitmq:4-alpine",
        brokerVersion: await docker([
          "exec",
          containerId,
          "rabbitmq-diagnostics",
          "-q",
          "server_version",
        ]),
        postgresVersion: (await pool.query("SHOW server_version")).rows[0]
          .server_version,
        nodeVersion: process.version,
        brokerSigkillRestarts: restartCount,
        elapsedMs: Date.now() - started,
        results,
        finalCounts: stats.counts,
      },
      null,
      2,
    ),
  );
} finally {
  const failures = [];
  for (const clean of [
    () => inbox?.close(),
    () => channel?.close().catch(() => {}),
    () => connection?.close().catch(() => {}),
    () => prisma.$disconnect(),
    () => pool.end(),
    () =>
      containerId && /^[0-9a-f]{64}$/.test(containerId)
        ? docker(["rm", "--force", "--volumes", containerId])
        : undefined,
    () => (volumeCreated ? docker(["volume", "rm", volume]) : undefined),
  ]) {
    try {
      await clean();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Broker recovery fixture cleanup failed",
    );
}
