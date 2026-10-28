const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { resolve } = require("node:path");
const { setTimeout } = require("node:timers/promises");

const root = resolve(__dirname, "../..");
let containerId;
let child;
let interrupted;

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

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    child?.kill(signal);
  });
}

async function withRabbitmq(run) {
  try {
    containerId = await capture("docker", [
      "create",
      "--name",
      `nestarc-inbox-rabbitmq-${randomBytes(8).toString("hex")}`,
      "--label",
      "dev.nestarc.inbox.fixture=true",
      "--publish",
      "127.0.0.1::5672",
      "--tmpfs",
      "/var/lib/rabbitmq",
      "rabbitmq:4-alpine",
    ]);
    if (!/^[a-f0-9]{64}$/.test(containerId))
      throw new Error("Unexpected fixture container identity");
    await capture("docker", ["start", containerId]);
    const deadline = Date.now() + 60_000;
    let ready = false;
    let lastReadinessError;
    while (Date.now() < deadline && !interrupted) {
      try {
        await capture("docker", [
          "exec",
          "--user",
          "rabbitmq",
          containerId,
          "rabbitmq-diagnostics",
          "-q",
          "check_port_connectivity",
        ]);
        ready = true;
        break;
      } catch (error) {
        lastReadinessError = error;
        await setTimeout(500);
      }
    }
    if (!ready) {
      console.error(
        await capture("docker", ["logs", "--tail", "150", containerId]),
      );
      throw new Error(
        `RabbitMQ fixture did not become ready: ${String(lastReadinessError)}`,
      );
    }
    const binding = await capture("docker", ["port", containerId, "5672/tcp"]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
    if (!match) throw new Error("RabbitMQ must be bound to one loopback port");
    console.log(`Disposable RabbitMQ fixture ready on 127.0.0.1:${match[1]}.`);
    return await run(`amqp://guest:guest@127.0.0.1:${match[1]}`);
  } finally {
    if (containerId && /^[a-f0-9]{64}$/.test(containerId)) {
      await capture("docker", ["rm", "--force", "--volumes", containerId]);
    }
  }
}

async function main() {
  process.exitCode = await withRabbitmq(
    (url) =>
      new Promise((done, reject) => {
        child = spawn(
          process.execPath,
          [
            "scripts/with-test-db.mjs",
            process.execPath,
            "examples/scripts/smoke.cjs",
            "--rabbitmq",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              INBOX_EXAMPLE_AMQP_URL: url,
            },
            stdio: "inherit",
          },
        );
        child.on("error", reject);
        child.on("close", (code) => {
          child = undefined;
          done(code ?? 1);
        });
      }),
  );
}
module.exports = { withRabbitmq };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
