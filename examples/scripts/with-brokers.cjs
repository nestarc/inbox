const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createServer } = require("node:net");
const { resolve } = require("node:path");
const { setTimeout } = require("node:timers/promises");

const root = resolve(__dirname, "../..");
const images = {
  kafka: "docker.redpanda.com/redpandadata/redpanda:v26.2.6",
  redis: "redis:7.4.2-alpine",
  sqs: "softwaremill/elasticmq-native:1.7.1",
};

function capture(command, args) {
  return new Promise((done, reject) => {
    const process = spawn(command, args, { cwd: root });
    let output = "";
    let error = "";
    process.stdout.on("data", (chunk) => {
      output += chunk;
    });
    process.stderr.on("data", (chunk) => {
      error += chunk;
    });
    process.on("error", reject);
    process.on("close", (code) =>
      code === 0
        ? done(output.trim())
        : reject(new Error(`${command} failed: ${error || output}`)),
    );
  });
}

async function unusedLoopbackPort() {
  const server = createServer();
  return new Promise((done, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : done(port)));
    });
  });
}

/** Each call owns and removes only the container IDs it creates. */
async function withBrokers(run) {
  const containers = [];
  let interrupted;
  const onSignal = (signal) => {
    interrupted = signal;
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const checkInterrupted = () => {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  };
  async function create(kind, args) {
    checkInterrupted();
    const id = await capture("docker", [
      "create",
      "--name",
      `nestarc-inbox-${kind}-${randomBytes(8).toString("hex")}`,
      "--label",
      "dev.nestarc.inbox.fixture=true",
      ...args,
    ]);
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("Unexpected fixture container identity");
    containers.push(id);
    checkInterrupted();
    await capture("docker", ["start", id]);
    return id;
  }
  async function binding(id, port) {
    const result = await capture("docker", ["port", id, `${port}/tcp`]);
    if (!/^127\.0\.0\.1:\d+$/.test(result))
      throw new Error("Broker must have one loopback port binding");
    return result;
  }
  async function ready(label, probe) {
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
      checkInterrupted();
      try {
        await probe();
        return;
      } catch (error) {
        lastError = error;
        await setTimeout(300);
      }
    }
    throw new Error(
      `${label} fixture did not become ready: ${String(lastError)}`,
    );
  }
  try {
    await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
    // Kafka metadata advertises the actual random host port. If another process
    // acquires this port before Docker binds it, creation fails and cleans up.
    const kafkaPort = await unusedLoopbackPort();
    const kafkaId = await create("kafka", [
      "--publish",
      `127.0.0.1:${kafkaPort}:9092`,
      images.kafka,
      "redpanda",
      "start",
      "--mode",
      "dev-container",
      "--smp",
      "1",
      "--memory",
      "1G",
      "--reserve-memory",
      "0M",
      "--kafka-addr",
      "0.0.0.0:9092",
      "--advertise-kafka-addr",
      `127.0.0.1:${kafkaPort}`,
    ]);
    const redisId = await create("redis", [
      "--publish",
      "127.0.0.1::6379",
      "--tmpfs",
      "/data",
      images.redis,
    ]);
    const sqsId = await create("sqs", [
      "--publish",
      "127.0.0.1::9324",
      images.sqs,
    ]);
    const kafkaBroker = await binding(kafkaId, 9092);
    const redisBroker = await binding(redisId, 6379);
    const sqsEndpoint = `http://${await binding(sqsId, 9324)}`;
    const { Kafka, logLevel } = require("kafkajs");
    await ready("Kafka", async () => {
      const admin = new Kafka({
        brokers: [kafkaBroker],
        logLevel: logLevel.NOTHING,
        connectionTimeout: 1_000,
        requestTimeout: 2_000,
        retry: { retries: 0 },
      }).admin();
      try {
        await admin.connect();
        await admin.listTopics();
      } finally {
        await admin.disconnect();
      }
    });
    await ready("Redis", async () => {
      if (
        (await capture("docker", ["exec", redisId, "redis-cli", "ping"])) !==
        "PONG"
      )
        throw new Error("Redis did not respond PONG");
    });
    const { SQSClient, ListQueuesCommand } = require("@aws-sdk/client-sqs");
    const sqs = new SQSClient({
      endpoint: sqsEndpoint,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 },
    });
    try {
      await ready("ElasticMQ", () => sqs.send(new ListQueuesCommand({})));
    } finally {
      sqs.destroy();
    }
    checkInterrupted();
    console.log(
      "Disposable Kafka (Redpanda), Redis, and SQS-compatible ElasticMQ fixtures ready.",
    );
    return await run({
      INBOX_EXAMPLE_KAFKA_BROKER: kafkaBroker,
      INBOX_EXAMPLE_REDIS_URL: `redis://${redisBroker}`,
      INBOX_EXAMPLE_SQS_ENDPOINT: sqsEndpoint,
    });
  } catch (error) {
    for (const id of containers) {
      try {
        console.error(await capture("docker", ["logs", "--tail", "20", id]));
      } catch {
        /* preserve the original test failure */
      }
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    const results = await Promise.allSettled(
      containers.map((id) =>
        capture("docker", ["rm", "--force", "--volumes", id]),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(`Fixture cleanup failed: ${result.reason}`);
        process.exitCode = 1;
      }
    }
  }
}

async function main() {
  let child;
  const onInt = () => child?.kill("SIGINT");
  const onTerm = () => child?.kill("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    await withBrokers(
      (env) =>
        new Promise((done, reject) => {
          child = spawn(
            process.execPath,
            [
              "scripts/with-test-db.mjs",
              process.execPath,
              "examples/scripts/smoke.cjs",
              "--brokers",
            ],
            { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" },
          );
          child.on("error", reject);
          child.on("close", (code) => {
            child = undefined;
            code === 0
              ? done()
              : reject(new Error(`Broker examples exited ${code}`));
          });
        }),
    );
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

module.exports = { withBrokers };
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
