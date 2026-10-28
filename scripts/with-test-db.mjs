import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Always creates a disposable database. Existing DATABASE_URL values are ignored.
// PostgreSQL is bound to loopback and all of its data lives in a container tmpfs.
const root = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/with-test-db.mjs <command> [...args]");
  process.exit(1);
}

const image = process.env.INBOX_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
if (!/^postgres:(16|18)(?:\.\d+)?(?:-alpine)?$/.test(image)) {
  throw new Error(
    "INBOX_TEST_POSTGRES_IMAGE must be an official postgres 16 or 18 image.",
  );
}
const suffix = randomBytes(8).toString("hex");
const database = `nestarc_inbox_test_${suffix}`;
const name = `nestarc-inbox-test-${suffix}`;
const password = randomBytes(24).toString("hex");
let containerId;
let child;
let interrupted;

function capture(executable, argv, options = {}) {
  return new Promise((resolveResult, reject) => {
    const processHandle = spawn(executable, argv, { cwd: root, ...options });
    let stdout = "";
    let stderr = "";
    processHandle.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    processHandle.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    processHandle.on("error", reject);
    processHandle.on("close", (code) => {
      if (code === 0) resolveResult(stdout.trim());
      else reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function run(executable, argv, env) {
  return new Promise((resolveResult, reject) => {
    if (interrupted) return reject(new Error(`Interrupted by ${interrupted}`));
    child = spawn(executable, argv, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      child = undefined;
      resolveResult(code ?? (signal === "SIGINT" ? 130 : 143));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    child?.kill(signal);
  });
}

try {
  await capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
  containerId = await capture("docker", [
    "create",
    "--name",
    name,
    "--label",
    "dev.nestarc.inbox.fixture=true",
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "--env",
    "PGDATA=/var/lib/postgresql/data",
    "--env",
    `POSTGRES_DB=${database}`,
    "--env",
    "POSTGRES_USER=inbox_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    image,
    "-c",
    "max_connections=100",
  ]);
  if (!/^[0-9a-f]{64}$/.test(containerId))
    throw new Error("Unexpected test container identity");
  await capture("docker", ["start", containerId]);

  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && !interrupted) {
    try {
      // Use TCP: the image's temporary initialization server only listens on a
      // Unix socket and must not be mistaken for the final ready server.
      await capture("docker", [
        "exec",
        containerId,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "inbox_test",
        "-d",
        database,
      ]);
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  if (!ready)
    throw new Error(
      "Disposable PostgreSQL did not become ready within 60 seconds.",
    );

  const binding = await capture("docker", ["port", containerId, "5432/tcp"]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  if (!match)
    throw new Error(
      "Test PostgreSQL must have exactly one loopback port binding.",
    );
  const databaseUrl = `postgresql://inbox_test:${password}@127.0.0.1:${match[1]}/${database}`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    INBOX_TEST_DATABASE_URL: databaseUrl,
    INBOX_TEST_DATABASE: "1",
    INBOX_TEST_DATABASE_NAME: database,
  };
  console.log(`Disposable ${image} fixture ready on 127.0.0.1:${match[1]}.`);

  const generated = await run(
    process.execPath,
    [
      resolve(root, "node_modules/prisma/build/index.js"),
      "generate",
      "--config",
      resolve(root, "test/prisma/prisma.config.ts"),
    ],
    env,
  );
  if (generated !== 0)
    throw new Error(`Prisma test client generation failed (${generated}).`);
  process.exitCode = await run(command, args, env);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(
    "Database tests require a running Docker engine. They are never silently skipped.",
  );
  process.exitCode = interrupted === "SIGINT" ? 130 : 1;
} finally {
  if (containerId && /^[0-9a-f]{64}$/.test(containerId)) {
    try {
      // This ID belongs only to the temporary container created above.
      await capture("docker", ["rm", "--force", "--volumes", containerId]);
    } catch (error) {
      console.error(
        `Could not clean up disposable fixture ${name}: ${String(error)}`,
      );
      process.exitCode = 1;
    }
  }
}
