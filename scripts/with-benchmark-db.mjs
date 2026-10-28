import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Never use an application's DATABASE_URL or an existing Docker volume.
// A named volume exercises the Docker VM's disk instead of a PostgreSQL tmpfs.
const root = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomBytes(8).toString("hex");
const database = `nestarc_inbox_test_${suffix}`;
const name = `nestarc-inbox-benchmark-${suffix}`;
const volume = `${name}-data`;
const password = randomBytes(24).toString("hex");
const image = process.env.INBOX_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine";
if (!/^postgres:(16|18)(?:\.\d+)?(?:-alpine)?$/.test(image))
  throw new Error("Use an official PostgreSQL 16 or 18 image.");
let containerId;
let volumeCreated = false;
let child;
let interrupted;
let forceStop;

function stopChild(signal = "SIGTERM") {
  const task = child;
  if (!task) return;
  task.kill(signal);
  clearTimeout(forceStop);
  forceStop = setTimeout(() => task.kill("SIGKILL"), 5_000);
}

async function capture(command, args) {
  return new Promise((yes, no) => {
    const task = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => task.kill("SIGKILL"), 60_000);
    task.stdout.on("data", (chunk) => (stdout += chunk));
    task.stderr.on("data", (chunk) => (stderr += chunk));
    task.once("error", (error) => {
      clearTimeout(timeout);
      no(error);
    });
    task.once("close", (code) => {
      clearTimeout(timeout);
      return code === 0
        ? yes(stdout.trim())
        : no(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function run(args, env, report = false) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
  return new Promise((yes, no) => {
    child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: ["ignore", report ? "inherit" : 2, 2],
    });
    const deadline = setTimeout(() => stopChild(), 720_000);
    child.once("error", no);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(forceStop);
      child = undefined;
      yes(code ?? (signal === "SIGINT" ? 130 : 143));
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    stopChild(signal);
  });
}

try {
  const docker = JSON.parse(
    await capture("docker", ["info", "--format", "{{json .}}"]),
  );
  await capture("docker", [
    "volume",
    "create",
    "--label",
    "dev.nestarc.inbox.benchmark=true",
    volume,
  ]);
  volumeCreated = true;
  containerId = await capture("docker", [
    "create",
    "--name",
    name,
    "--label",
    "dev.nestarc.inbox.benchmark=true",
    "--cpus",
    "2",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "--publish",
    "127.0.0.1::5432",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
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
    "max_connections=40",
    "-c",
    "shared_buffers=128MB",
  ]);
  if (!/^[0-9a-f]{64}$/.test(containerId))
    throw new Error("Unexpected container ID.");
  await capture("docker", ["start", containerId]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (interrupted || Date.now() > deadline)
      throw new Error("Disposable PostgreSQL startup timed out.");
    try {
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
      break;
    } catch {
      await delay(250);
    }
  }
  const binding = /^127\.0\.0\.1:(\d+)$/.exec(
    await capture("docker", ["port", containerId, "5432/tcp"]),
  );
  if (!binding) throw new Error("Expected a loopback-only database port.");
  const metadata = JSON.parse(
    await capture("docker", ["inspect", "--format", "{{json .}}", containerId]),
  );
  if (
    !metadata.Mounts.some(
      (mount) => mount.Type === "volume" && mount.Name === volume,
    )
  )
    throw new Error(
      "The benchmark database is not on its dedicated disk-backed volume.",
    );
  const databaseUrl = `postgresql://inbox_test:${password}@127.0.0.1:${binding[1]}/${database}`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    INBOX_TEST_DATABASE_URL: databaseUrl,
    INBOX_TEST_DATABASE_NAME: database,
    INBOX_TEST_DATABASE: "1",
    INBOX_BENCHMARK_DISK_FIXTURE: "1",
    INBOX_BENCHMARK_ENVIRONMENT: JSON.stringify({
      docker: docker.ServerVersion,
      dockerLogicalCpus: docker.NCPU,
      dockerMemoryBytes: docker.MemTotal,
      image,
      imageId: metadata.Image,
      postgresCpuLimit: 2,
      postgresMemoryLimitBytes: 1_073_741_824,
      storage: "Dedicated Docker named volume on the host VM disk; no tmpfs",
    }),
  };
  console.error(
    `Disposable disk-backed ${image} ready; 2 CPU / 1 GiB database limit.`,
  );
  for (const args of [
    [
      resolve(root, "node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    [
      resolve(root, "node_modules/prisma/build/index.js"),
      "generate",
      "--config",
      resolve(root, "test/prisma/prisma.config.ts"),
    ],
  ]) {
    if ((await run(args, env)) !== 0)
      throw new Error("Benchmark preparation failed.");
  }
  process.exitCode = await run(
    [resolve(root, "scripts/benchmark-sustained.mjs")],
    env,
    true,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (containerId && /^[0-9a-f]{64}$/.test(containerId)) {
    try {
      await capture("docker", ["rm", "--force", "--volumes", containerId]);
    } catch (error) {
      console.error(`Fixture cleanup failed: ${error}`);
      process.exitCode = 1;
    }
  }
  if (volumeCreated) {
    try {
      await capture("docker", ["volume", "rm", volume]);
    } catch (error) {
      console.error(`Volume cleanup failed: ${error}`);
      process.exitCode = 1;
    }
  }
}
