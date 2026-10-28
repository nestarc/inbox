import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyArtifact } from "./release-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const releaseTarball = process.env.INBOX_RELEASE_TARBALL;
const releaseMetadata = process.env.INBOX_RELEASE_METADATA;
const candidateMode =
  releaseTarball !== undefined || releaseMetadata !== undefined;
if (
  candidateMode &&
  (!releaseTarball ||
    !releaseMetadata ||
    !isAbsolute(releaseTarball) ||
    !isAbsolute(releaseMetadata))
) {
  throw new Error(
    "Set both INBOX_RELEASE_TARBALL and INBOX_RELEASE_METADATA to absolute paths.",
  );
}
let activeChild;
let interrupted;
let candidate;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    activeChild?.kill(signal);
  });
}
if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  !process.env.INBOX_TEST_DATABASE_URL
) {
  throw new Error(
    "Use scripts/with-test-db.mjs to provide a disposable database.",
  );
}

function run(command, args, cwd, env = process.env, capture = false) {
  return new Promise((done, reject) => {
    if (interrupted) return reject(new Error(`Interrupted by ${interrupted}`));
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChild = child;
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      return code === 0
        ? done(output.trim())
        : reject(new Error(`${command} exited ${code}`));
    });
  });
}

const directory = await mkdtemp(
  join(tmpdir(), "nestarc-inbox-packed-examples-"),
);
async function verifyCandidateAfterTests() {
  if (!candidate) return;
  if (
    !(await readFile(releaseMetadata)).equals(candidate.metadataBytes) ||
    !(await readFile(candidate.metadataPath)).equals(candidate.metadataBytes)
  )
    throw new Error("Release candidate metadata changed during example tests.");
  await verifyArtifact(
    releaseTarball,
    candidate.metadataPath,
    candidate.options,
  );
  await verifyArtifact(
    candidate.tarballPath,
    candidate.metadataPath,
    candidate.options,
  );
}
try {
  const cache = join(tmpdir(), "nestarc-inbox-example-npm-cache");
  let tarball;
  if (candidateMode) {
    const manifest = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const options = {
      expectedVersion: manifest.version,
      ...(process.env.GITHUB_SHA
        ? { expectedCommit: process.env.GITHUB_SHA }
        : {}),
    };
    const metadataBytes = await readFile(releaseMetadata);
    await verifyArtifact(releaseTarball, releaseMetadata, options);
    tarball = join(directory, basename(releaseTarball));
    const metadataPath = join(directory, "release-metadata.json");
    await copyFile(releaseTarball, tarball);
    await writeFile(metadataPath, metadataBytes, { flag: "wx" });
    await chmod(tarball, 0o444);
    await chmod(metadataPath, 0o444);
    await verifyArtifact(tarball, metadataPath, options);
    candidate = { tarballPath: tarball, metadataPath, metadataBytes, options };
    console.log(`Verified release candidate: ${basename(tarball)}.`);
  } else {
    await run("npm", ["run", "build"], root);
    const result = JSON.parse(
      await run(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--cache",
          cache,
          "--pack-destination",
          directory,
        ],
        root,
        process.env,
        true,
      ),
    );
    if (
      result.length !== 1 ||
      !/^nestarc-inbox-[\w.-]+\.tgz$/.test(result[0].filename)
    ) {
      throw new Error("Unexpected npm pack result.");
    }
    tarball = join(directory, result[0].filename);
  }
  const unpacked = join(directory, "unpacked");
  await mkdir(unpacked);
  await run("tar", ["-xzf", tarball, "-C", unpacked], root);
  const consumer = join(unpacked, "package", "examples");
  await run(
    "npm",
    ["install", "--no-save", "--cache", cache, tarball],
    consumer,
  );
  // This runs the examples shipped INSIDE the tarball with their own dependency
  // tree. Repository source imports and the repository node_modules cannot mask
  // missing package assets, exports, or example dependencies.
  const { withRabbitmq } = require(
    join(consumer, "scripts", "with-rabbitmq.cjs"),
  );
  const { withBrokers } = require(
    join(consumer, "scripts", "with-brokers.cjs"),
  );
  await withRabbitmq(async (brokerUrl) => {
    await withBrokers(async (brokers) => {
      await run(
        process.execPath,
        ["scripts/smoke.cjs", "--rabbitmq", "--brokers"],
        consumer,
        {
          ...process.env,
          ...brokers,
          INBOX_EXAMPLE_AMQP_URL: brokerUrl,
        },
      );
    });
  });
} finally {
  try {
    await verifyCandidateAfterTests();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  "Packed outbox, webhook, tenancy, idempotency, RabbitMQ, Kafka, SQS-compatible, and BullMQ examples passed.",
);
