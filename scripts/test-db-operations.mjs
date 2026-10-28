import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// No application DATABASE_URL is read. Every modified server is created here.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const image = "postgres:16-alpine";
const suffix = randomBytes(8).toString("hex");
const database = `nestarc_inbox_test_${suffix}`;
const password = randomBytes(24).toString("hex");
const networkName = `nestarc-inbox-operations-${suffix}`;
const label = `dev.nestarc.inbox.operations=${suffix}`;
const containers = [];
const closers = [];
const processes = new Set();
let networkId;
let interrupted;

function command(executable, args, options = {}) {
  const { cleanup = false, ...spawnOptions } = options;
  if (interrupted && !cleanup)
    return Promise.reject(new Error(`Interrupted by ${interrupted}`));
  return new Promise((yes, no) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...spawnOptions,
    });
    processes.add(child);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.stdout?.on("data", (value) => (stdout += value));
    child.stderr?.on("data", (value) => (stderr += value));
    child.once("error", no);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      processes.delete(child);
      if (code === 0) yes(stdout.trim());
      else
        no(
          new Error(
            `${executable} failed (${code ?? signal}): ${stderr.slice(-4000)}`,
          ),
        );
    });
  });
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    interrupted = signal;
    for (const child of processes) child.kill(signal);
  });
}
const docker = (...args) => command("docker", args);
async function until(description, condition, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline && !interrupted) {
    if (await condition()) return;
    await delay(50);
  }
  throw new Error(
    `Timed out: ${description}${interrupted ? ` (${interrupted})` : ""}`,
  );
}
async function startContainer(kind, extra = [], entrypoint = []) {
  const name = `nestarc-inbox-${kind}-${suffix}`;
  const id = await docker(
    "create",
    "--name",
    name,
    "--label",
    label,
    "--label",
    "dev.nestarc.inbox.fixture=true",
    "--network",
    networkName,
    "--network-alias",
    kind,
    "--publish",
    "127.0.0.1::5432",
    "--memory",
    "768m",
    "--cpus",
    "1",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=512m",
    "--env",
    "PGDATA=/var/lib/postgresql/data",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    "POSTGRES_USER=inbox_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `PGPASSWORD=${password}`,
    ...extra,
    image,
    ...entrypoint,
  );
  assert.match(id, /^[0-9a-f]{64}$/);
  containers.push(id);
  await docker("start", id);
  await until(
    `${kind} PostgreSQL readiness`,
    async () => {
      try {
        await docker(
          "exec",
          id,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "inbox_test",
          "-d",
          database,
        );
        return true;
      } catch {
        return false;
      }
    },
    60_000,
  );
  const binding = await docker("port", id, "5432/tcp");
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  assert.ok(match, "Only an isolated loopback port is allowed");
  const connectionString = `postgresql://inbox_test:${password}@127.0.0.1:${match[1]}/${database}`;
  return { id, connectionString };
}
function poolFor(server) {
  const pool = new Pool({
    connectionString: server.connectionString,
    max: 3,
    connectionTimeoutMillis: 1500,
    query_timeout: 5000,
  });
  pool.on("error", () => {}); // Expected when the disposable primary is killed.
  closers.push(() => pool.end());
  return pool;
}
const message = (messageId, payload = { value: 1 }) => ({
  scope: { kind: "global" },
  source: "db-operations",
  consumer: "db-operations.v1",
  messageId,
  eventType: "operation",
  schemaVersion: 1,
  payload,
});
async function setup(pool) {
  await pool.query(
    await readFile(resolve(root, "src/sql/create-inbox-table.sql"), "utf8"),
  );
  // No unique key masks a duplicate committed business effect.
  await pool.query(
    "CREATE TABLE inbox_operation_effects (inbox_id uuid NOT NULL, kind text NOT NULL)",
  );
}
async function writeEffects(tx, id) {
  await tx.$executeRawUnsafe(
    "INSERT INTO inbox_operation_effects VALUES ($1::uuid,'business'),($1::uuid,'outbox')",
    id,
  );
}
async function assertEffects(pool, id, count) {
  const { rows } = await pool.query(
    "SELECT kind,count(*)::integer AS count FROM inbox_operation_effects WHERE inbox_id=$1::uuid GROUP BY kind ORDER BY kind",
    [id],
  );
  assert.deepEqual(
    rows,
    count
      ? [
          { kind: "business", count },
          { kind: "outbox", count },
        ]
      : [],
  );
}

let InboxService;
let PrismaClient;
let PrismaPg;
async function serviceFor(server, handler) {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: server.connectionString,
      max: 5,
      connectionTimeoutMillis: 1000,
    }),
  });
  const service = new InboxService({
    prisma,
    handlers: [
      {
        consumer: "db-operations.v1",
        eventType: "operation",
        schemaVersion: 1,
        handle:
          handler ??
          ((_payload, context) => writeEffects(context.tx, context.inboxId)),
      },
    ],
    worker: {
      enabled: false,
      concurrency: 1,
      leaseMs: 2000,
      heartbeatIntervalMs: 200,
      transactionTimeoutMs: 6000,
      transactionMaxWaitMs: 1000,
      shutdownTimeoutMs: 7000,
      retryBaseMs: 10,
      retryMaxMs: 20,
    },
  });
  closers.push(async () => {
    await service.close();
    await prisma.$disconnect();
  });
  await service.initialize();
  return service;
}
async function drain(service, ids) {
  await until(
    "all preserved receipts complete",
    async () => {
      await service.runOnce();
      const records = await Promise.all(
        ids.map((id) => service.admin.forGlobal().get(id)),
      );
      return records.every((record) => record?.status === "COMPLETED");
    },
    20_000,
  );
}

async function failoverScenario() {
  const primary = await startContainer(
    "primary",
    [],
    [
      "postgres",
      "-c",
      "wal_level=replica",
      "-c",
      "max_wal_senders=5",
      "-c",
      "wal_keep_size=64MB",
    ],
  );
  const primaryPool = poolFor(primary);
  await setup(primaryPool);
  await docker(
    "exec",
    primary.id,
    "sh",
    "-c",
    "printf '\nhost replication inbox_test all scram-sha-256\n' >> \"$PGDATA/pg_hba.conf\"",
  );
  await primaryPool.query("SELECT pg_reload_conf()");
  const standby = await startContainer(
    "standby",
    [],
    [
      "sh",
      "-ec",
      'chown postgres:postgres "$PGDATA"; chmod 700 "$PGDATA"; su-exec postgres pg_basebackup -h primary -U inbox_test -D "$PGDATA" -R -X stream -c fast; exec su-exec postgres postgres -c hot_standby=on',
    ],
  );
  const standbyPool = poolFor(standby);
  assert.equal(
    (await standbyPool.query("SELECT pg_is_in_recovery() AS recovery")).rows[0]
      .recovery,
    true,
  );
  let reached = false;
  let resume;
  const gate = new Promise((yes) => (resume = yes));
  const ingress = await serviceFor(primary, async (payload, context) => {
    await writeEffects(context.tx, context.inboxId);
    if (payload.pause) {
      reached = true;
      await gate;
      await context.tx.$queryRawUnsafe("SELECT 1");
    }
  });
  const completed = await ingress.accept(message("before-failover-completed"));
  await ingress.runOnce();
  await assertEffects(primaryPool, completed.id, 1);
  const processingMessage = message("before-failover-processing", {
    pause: true,
  });
  const processing = await ingress.accept(processingMessage);
  const running = ingress.runOnce();
  await until(
    "handler uncommitted-write boundary",
    async () => reached,
    10_000,
  );
  const pendingMessage = message("before-failover-pending");
  const pending = await ingress.accept(pendingMessage);
  const lsn = (
    await primaryPool.query("SELECT pg_current_wal_flush_lsn()::text AS lsn")
  ).rows[0].lsn;
  await until(
    "standby replay of accepted receipts and claim",
    async () =>
      (
        await standbyPool.query(
          "SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS replayed",
          [lsn],
        )
      ).rows[0].replayed === true,
  );
  await assertEffects(standbyPool, processing.id, 0);
  const before = await standbyPool.query(
    "SELECT id,status FROM nestarc_inbox ORDER BY id",
  );
  assert.equal(
    before.rows.find((row) => row.id === processing.id).status,
    "PROCESSING",
  );
  const started = Date.now();
  await docker("kill", "--signal", "KILL", primary.id);
  resume();
  await running;
  assert.equal(
    (await standbyPool.query("SELECT pg_promote(true, 20) AS promoted")).rows[0]
      .promoted,
    true,
  );
  assert.equal(
    (await standbyPool.query("SELECT pg_is_in_recovery() AS recovery")).rows[0]
      .recovery,
    false,
  );
  const replacement = await serviceFor(standby);
  assert.deepEqual(
    await replacement.accept(message("before-failover-completed")),
    { kind: "duplicate", id: completed.id, status: "COMPLETED" },
  );
  assert.equal((await replacement.accept(processingMessage)).kind, "duplicate");
  assert.equal((await replacement.accept(pendingMessage)).kind, "duplicate");
  await assertEffects(standbyPool, processing.id, 0);
  await drain(replacement, [completed.id, processing.id, pending.id]);
  for (const record of [completed, processing, pending])
    await assertEffects(standbyPool, record.id, 1);
  assert.equal(
    (await replacement.admin.forGlobal().get(processing.id)).attemptCount,
    2,
  );
  return {
    scenario: "streaming-standby-promotion",
    passed: true,
    acceptedReceipts: 3,
    committedBusinessEffects: 3,
    committedOutboxEffects: 3,
    recoveryMs: Date.now() - started,
    replayedBeforePrimaryKill: lsn,
    replicationBoundary:
      "explicitly awaited standby replay before primary SIGKILL; not a claim of zero-loss asynchronous replication",
  };
}

async function diskScenario() {
  const server = await startContainer("disk", [
    "--tmpfs",
    "/inbox-limited:rw,size=16m",
  ]);
  const pool = poolFor(server);
  await setup(pool);
  await docker(
    "exec",
    server.id,
    "chown",
    "postgres:postgres",
    "/inbox-limited",
  );
  await pool.query("CREATE TABLESPACE inbox_limited LOCATION '/inbox-limited'");
  await pool.query(
    "CREATE TABLE inbox_disk_ballast(body bytea) TABLESPACE inbox_limited; ALTER TABLE inbox_disk_ballast ALTER COLUMN body SET STORAGE EXTERNAL; CREATE TABLE inbox_disk_business(body bytea) TABLESPACE inbox_limited; ALTER TABLE inbox_disk_business ALTER COLUMN body SET STORAGE EXTERNAL",
  );
  const block = randomBytes(1024 * 1024);
  let fillRows = 0;
  let fullError;
  for (; fillRows < 32; fillRows++) {
    try {
      await pool.query("INSERT INTO inbox_disk_ballast VALUES ($1)", [block]);
    } catch (error) {
      fullError = error;
      break;
    }
  }
  assert.equal(
    fullError?.code,
    "53100",
    "Expected real PostgreSQL disk_full from the capped 16 MiB mount",
  );
  console.error(
    "Tablespace reached SQLSTATE 53100; checking handler rollback.",
  );
  let handlerError;
  const inbox = await serviceFor(server, async (_payload, context) => {
    await writeEffects(context.tx, context.inboxId);
    try {
      await context.tx.$executeRawUnsafe(
        "INSERT INTO inbox_disk_business VALUES ($1)",
        block,
      );
    } catch (error) {
      handlerError = error;
      throw error;
    }
  });
  const envelope = message("disk-full-business");
  const receipt = await inbox.accept(envelope);
  await inbox.runOnce();
  assert.ok(handlerError, "Handler must encounter the exhausted tablespace");
  const failed = await inbox.admin.forGlobal().get(receipt.id);
  assert.equal(failed.status, "RETRYABLE");
  assert.equal(failed.attemptCount, 1);
  await assertEffects(pool, receipt.id, 0);
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) AS count FROM inbox_disk_business"))
        .rows[0].count,
    ),
    0,
  );
  console.error("Disk-full handler rolled back; releasing ballast.");
  // TRUNCATE itself needs space for replacement relation/index files. Dropping
  // this disposable ballast first releases blocks even when the mount is full.
  await pool.query("DROP TABLE inbox_disk_ballast");
  await pool.query("TRUNCATE inbox_disk_business");
  const started = Date.now();
  await drain(inbox, [receipt.id]);
  await assertEffects(pool, receipt.id, 1);
  assert.equal((await inbox.admin.forGlobal().get(receipt.id)).attemptCount, 2);
  assert.equal((await inbox.accept(envelope)).kind, "duplicate");
  assert.equal(
    Number(
      (await pool.query("SELECT count(*) AS count FROM inbox_disk_business"))
        .rows[0].count,
    ),
    1,
  );
  return {
    scenario: "tablespace-enospc-recovery",
    passed: true,
    filesystemLimitBytes: 16 * 1024 * 1024,
    fillerRows: fillRows,
    postgresSqlstate: fullError.code,
    failedAttemptEffects: 0,
    committedBusinessEffects: 1,
    committedOutboxEffects: 1,
    attempts: 2,
    recoveryMs: Date.now() - started,
    scope:
      "business data tablespace ENOSPC; WAL/system-volume exhaustion is not covered",
  };
}

const report = {
  node: process.version,
  image,
  startedAt: new Date().toISOString(),
  scenarios: [],
};
try {
  await command("npm", ["run", "build"]);
  await command(process.execPath, [
    "node_modules/prisma/build/index.js",
    "generate",
    "--config",
    "test/prisma/prisma.config.ts",
  ]);
  ({ InboxService } = require("../dist/index.js"));
  ({ PrismaClient } = require("../test/prisma/generated"));
  ({ PrismaPg } = require("@prisma/adapter-pg"));
  report.docker = await docker("version", "--format", "{{.Server.Version}}");
  networkId = await docker("network", "create", "--label", label, networkName);
  assert.match(networkId, /^[0-9a-f]{64}$/);
  console.error(
    "Running isolated PostgreSQL standby promotion and tablespace ENOSPC tests.",
  );
  report.scenarios.push(await failoverScenario());
  console.error("Streaming-standby promotion passed.");
  report.scenarios.push(await diskScenario());
  console.error("Bounded tablespace ENOSPC and recovery passed.");
  report.passed = true;
} catch (error) {
  console.error(error);
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const close of closers.reverse()) {
    try {
      await close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  for (const id of containers.reverse()) {
    try {
      await command("docker", ["rm", "--force", "--volumes", id], {
        cleanup: true,
      });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  if (networkId) {
    try {
      await command("docker", ["network", "rm", networkId], { cleanup: true });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  report.cleanedUp = cleanupErrors.length === 0;
  if (cleanupErrors.length) {
    report.cleanupErrors = cleanupErrors;
    report.passed = false;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.INBOX_DB_OPERATIONS_REPORT)
    await writeFile(resolve(process.env.INBOX_DB_OPERATIONS_REPORT), json, {
      flag: "wx",
    });
  process.stdout.write(json);
}
