import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifact } from "./release-artifact.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
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

// This smoke test creates tables, so accept only the runner's disposable DB.
const databaseUrl = process.env.INBOX_TEST_DATABASE_URL;
const databaseName = process.env.INBOX_TEST_DATABASE_NAME;
if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  !databaseUrl ||
  process.env.DATABASE_URL !== databaseUrl ||
  !/^nestarc_inbox_test_[0-9a-f]{16}$/.test(databaseName ?? "")
) {
  throw new Error("Run this script through scripts/with-test-db.mjs.");
}
const url = new URL(databaseUrl);
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "127.0.0.1" ||
  !url.port ||
  url.username !== "inbox_test" ||
  url.pathname !== `/${databaseName}` ||
  url.search ||
  url.hash
) {
  throw new Error("Refusing package tests against a non-fixture database.");
}

const directory = await mkdtemp(join(tmpdir(), "nestarc-inbox-package-"));
const env = {
  ...process.env,
  npm_config_cache:
    process.env.npm_config_cache ??
    process.env.NPM_CONFIG_CACHE ??
    join(tmpdir(), "nestarc-inbox-npm-cache"),
};
let child;
let interrupted;
let candidate;
let successMessage;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = signal;
    child?.kill(signal);
  });
}
function run(executable, args, cwd = directory, capture = false) {
  return new Promise((resolveResult, reject) => {
    if (interrupted) return reject(new Error(`Interrupted by ${interrupted}`));
    child = spawn(executable, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    let stdout = "";
    if (capture)
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolveResult(capture ? stdout : undefined);
      else reject(new Error(`${executable} failed (${code ?? signal}).`));
    });
  });
}

function assertPackagePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.includes("\\")
  ) {
    throw new Error("Invalid file path in packed package manifest.");
  }
  const components = path.split("/");
  if (
    components.some(
      (part) =>
        ["..", "node_modules", ".git", "test", "tests", "__tests__"].includes(
          part,
        ) ||
        part === ".env" ||
        part.startsWith(".env."),
    ) ||
    /^examples\/dist(?:\/|$)/.test(path) ||
    /^examples\/src\/generated(?:\/|$)/.test(path)
  )
    throw new Error(`Unexpected package artifact: ${path}`);
}

async function inspectInstalledFiles(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assertPackagePath(relative);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected package symlink: ${relative}`);
    if (entry.isDirectory())
      await inspectInstalledFiles(join(directory, entry.name), relative);
  }
}

async function verifyCandidateAfterTests() {
  if (!candidate) return;
  // Pin the metadata bytes checked before install, so replacing both files cannot
  // silently change which candidate this test run approved.
  if (
    !(await readFile(releaseMetadata)).equals(candidate.metadataBytes) ||
    !(await readFile(candidate.metadataPath)).equals(candidate.metadataBytes)
  )
    throw new Error("Release candidate metadata changed during package tests.");
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
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  let tarballName;
  if (candidateMode) {
    const options = {
      expectedVersion: manifest.version,
      ...(process.env.GITHUB_SHA
        ? { expectedCommit: process.env.GITHUB_SHA }
        : {}),
    };
    const metadataBytes = await readFile(releaseMetadata);
    await verifyArtifact(releaseTarball, releaseMetadata, options);
    tarballName = basename(releaseTarball);
    const tarballPath = join(directory, tarballName);
    const metadataPath = join(directory, "release-metadata.json");
    await copyFile(releaseTarball, tarballPath);
    await writeFile(metadataPath, metadataBytes, { flag: "wx" });
    await chmod(tarballPath, 0o444);
    await chmod(metadataPath, 0o444);
    await verifyArtifact(tarballPath, metadataPath, options);
    candidate = { tarballPath, metadataPath, metadataBytes, options };
    const archivePaths = (await run("tar", ["-tzf", tarballPath], root, true))
      .trim()
      .split("\n");
    for (const archivePath of archivePaths) {
      if (archivePath === "package/") continue;
      if (!archivePath.startsWith("package/"))
        throw new Error("Unexpected package archive root.");
      assertPackagePath(
        archivePath.slice("package/".length).replace(/\/$/, ""),
      );
    }
    console.log(`Verified release candidate: ${tarballName}.`);
  } else {
    // npm pack executes the package's prepack build; no publishing is performed.
    const packed = JSON.parse(
      await run(
        "npm",
        [
          "pack",
          "--json",
          "--loglevel=error",
          "--foreground-scripts=false",
          "--workspaces=false",
          "--pack-destination",
          directory,
        ],
        root,
        true,
      ),
    );
    if (
      !Array.isArray(packed) ||
      packed.length !== 1 ||
      !Array.isArray(packed[0]?.files) ||
      !packed[0].files.length
    ) {
      throw new Error("Expected one non-empty npm pack file manifest.");
    }
    // Check every archive path before npm install, including nested example output.
    for (const file of packed[0].files) assertPackagePath(file?.path);
    const tarballs = (await readdir(directory)).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (tarballs.length !== 1)
      throw new Error("Expected exactly one built package tarball.");
    if (packed[0].filename !== tarballs[0])
      throw new Error(
        "Packed file manifest does not match the generated tarball.",
      );
    console.log(
      `Packed artifact validated: ${packed[0].files.length} files, ${packed[0].size} bytes.`,
    );
    tarballName = tarballs[0];
  }
  const dependencies = {};
  for (const name of [
    "@nestjs/common",
    "@nestjs/core",
    "@prisma/client",
    "@prisma/adapter-pg",
    "reflect-metadata",
    "rxjs",
    "pg",
    "prisma",
    "typescript",
    "@types/node",
    "@types/pg",
  ]) {
    const version = manifest.devDependencies[name];
    if (!version) throw new Error(`Missing explicit test dependency ${name}.`);
    dependencies[name] = version;
  }
  dependencies["@nestarc/inbox"] = `file:./${tarballName}`;
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name: "nestarc-inbox-packed-consumer",
        version: "0.0.0",
        private: true,
        type: "commonjs",
        dependencies,
      },
      null,
      2,
    ),
  );
  await run("npm", [
    "install",
    "--strict-peer-deps",
    "--no-audit",
    "--no-fund",
  ]);

  await writeFile(
    join(directory, "schema.prisma"),
    String.raw`
generator client {
  provider = "prisma-client-js"
  output = "./generated"
}
datasource db {
  provider = "postgresql"
}
model Effect {
  id String @id
  value Int @default(0)
  @@map("package_consumer_effect")
}
`,
  );
  await writeFile(
    join(directory, "prisma.config.ts"),
    String.raw`
import { defineConfig, env } from 'prisma/config';
export default defineConfig({ schema: './schema.prisma', datasource: { url: env('DATABASE_URL') } });
`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: false,
          types: ["node"],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(directory, "consumer.ts"),
    String.raw`
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated';
import {
  InboxService, InboxModule, InboxPermanentError, createInboxTenancyContext,
  type InboxHandler, type InboxEnvelope, type InboxContext,
  type InboxReplayOptions, type InboxReplayResult, type InboxTenancyOptions,
} from '@nestarc/inbox';
import { drainInbox, waitForInboxRecord, InboxTestError } from '@nestarc/inbox/testing';

async function main() {
  assert.equal(typeof InboxService, 'function');
  assert.equal(typeof InboxModule.forRootAsync, 'function');
  assert.equal(typeof createInboxTenancyContext, 'function');
  assert.equal(typeof drainInbox, 'function');
  assert.equal(typeof InboxTestError, 'function');
  assert.ok(require.resolve('@nestarc/inbox/testing').includes('node_modules'));
  // Optional integration must not make base imports or declarations require tenancy.
  assert.throws(() => require.resolve('@nestarc/tenancy'), { code: 'MODULE_NOT_FOUND' });
  const entry = require.resolve('@nestarc/inbox');
  assert.ok(entry.includes('node_modules'));
  const migrationPath = require.resolve('@nestarc/inbox/sql/create-inbox-table.sql');
  const migration = await readFile(migrationPath, 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.nestarc_inbox/);
  const upgradePath = require.resolve('@nestarc/inbox/sql/migrate-v1-to-v2.sql');
  const upgrade = await readFile(upgradePath, 'utf8');
  assert.match(upgrade, /ADD COLUMN IF NOT EXISTS replay_of uuid/);
  assert.match(upgrade, /SET version=2/);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  let inbox: InboxService | undefined;
  try {
    await pool.query(migration);
    await pool.query('CREATE TABLE package_consumer_effect (id text PRIMARY KEY, value integer NOT NULL DEFAULT 0)');
    const observedReplays: Array<InboxContext<Prisma.TransactionClient>['replay']> = [];
    // Exercise the structural public adapter contract without installing its optional peer.
    const tenancyOptions: InboxTenancyOptions = {
      context: { run: async (_tenantId, next) => next() },
      tenancy: {
        getDbSettingKey: () => 'app.package_tenant',
        getCurrentTenantOrThrow: () => 'pack-tenant',
        withoutTenant: async (next) => next(),
      },
    };
    const handler: InboxHandler<{ key: string }, Prisma.TransactionClient> = {
      consumer: 'pack.success.v1', eventType: 'pack.received', schemaVersion: 1,
      async handle(payload, { tx, replay }) {
        const setting = await tx.$queryRawUnsafe<Array<{ tenant: string }>>("SELECT current_setting('app.package_tenant', true) AS tenant");
        assert.equal(setting[0]?.tenant, 'pack-tenant');
        observedReplays.push(replay);
        await tx.effect.upsert({
          where: { id: payload.key },
          create: { id: payload.key, value: 1 },
          update: { value: { increment: 1 } },
        });
      },
    };
    const failing: InboxHandler<{ key: string }, Prisma.TransactionClient> = {
      consumer: 'pack.rollback.v1', eventType: 'pack.received', schemaVersion: 1,
      async handle(payload, { tx }) {
        await tx.effect.create({ data: { id: payload.key, value: 1 } });
        throw new InboxPermanentError('Expected rollback');
      },
    };
    let retryCalls = 0;
    const retrying: InboxHandler<{ key: string }, Prisma.TransactionClient> = {
      consumer: 'pack.retry.v1', eventType: 'pack.received', schemaVersion: 1,
      async handle(payload, { tx }) {
        await tx.effect.create({ data: { id: payload.key, value: 1 } });
        if (++retryCalls === 1) throw new Error('Expected transient failure');
      },
    };
    inbox = new InboxService({
      prisma, handlers: [handler, failing, retrying], worker: { enabled: false, retryBaseMs: 100, retryMaxMs: 100 },
      handlerContext: createInboxTenancyContext(tenancyOptions),
    });
    await inbox.initialize();
    const envelope: InboxEnvelope<{ key: string }> = {
      scope: { kind: 'tenant', id: 'pack-tenant' }, source: 'pack-source',
      consumer: 'pack.success.v1', messageId: 'message-1',
      eventType: 'pack.received', schemaVersion: 1, payload: { key: 'success' },
    };
    const receipts = await Promise.all(Array.from({ length: 20 }, () => inbox!.accept(envelope)));
    assert.equal(receipts.filter((receipt) => receipt.kind === 'accepted').length, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.id)).size, 1);
    assert.equal(await inbox.runOnce(), 1);
    assert.equal((await prisma.effect.findUniqueOrThrow({ where: { id: 'success' } })).value, 1);
    const admin = inbox.admin.forTenant('pack-tenant');
    const completed = await admin.get(receipts[0]!.id);
    assert.equal(completed?.status, 'COMPLETED');
    assert.equal((await inbox.accept(envelope)).kind, 'duplicate');
    assert.equal(await inbox.runOnce(), 0);
    assert.equal((await prisma.effect.findUniqueOrThrow({ where: { id: 'success' } })).value, 1);
    assert.deepEqual(observedReplays, [undefined]);

    assert.ok(completed);
    const replayRequest: InboxReplayOptions = {
      id: completed.id, expectedVersion: completed.rowVersion, requestId: randomUUID(),
      targetConsumer: handler.consumer, actor: 'package-test', reason: 'Verify intentional completed replay',
    };
    const replay: InboxReplayResult = await admin.replay(replayRequest);
    const repeatedReplay: InboxReplayResult = await admin.replay(replayRequest);
    assert.equal(replay.kind, 'accepted');
    assert.equal(repeatedReplay.kind, 'duplicate');
    assert.equal(repeatedReplay.record.id, replay.record.id);
    assert.notEqual(replay.record.id, completed.id);
    assert.equal(replay.record.replay?.originalInboxId, completed.id);
    assert.equal(replay.record.replay?.requestId, replayRequest.requestId);
    assert.equal(await inbox.runOnce(), 1);
    assert.equal((await prisma.effect.findUniqueOrThrow({ where: { id: 'success' } })).value, 2);
    assert.equal(observedReplays.length, 2);
    assert.deepEqual(observedReplays[1], replay.record.replay);
    const replayAgain = await admin.replay(replayRequest);
    assert.equal(replayAgain.kind, 'duplicate');
    assert.equal(replayAgain.record.id, replay.record.id);
    assert.equal(replayAgain.record.status, 'COMPLETED');
    assert.deepEqual(await admin.get(completed.id), completed);
    assert.equal((await inbox.accept(envelope)).kind, 'duplicate');
    assert.equal(await inbox.runOnce(), 0);
    assert.equal((await prisma.effect.findUniqueOrThrow({ where: { id: 'success' } })).value, 2);

    const failure = await inbox.accept({ ...envelope, consumer: 'pack.rollback.v1', messageId: 'message-2', payload: { key: 'rollback' } });
    await inbox.runOnce();
    assert.equal(await prisma.effect.count({ where: { id: 'rollback' } }), 0);
    const dead = await admin.get(failure.id);
    assert.equal(dead?.status, 'DEAD');
    const page = await admin.list({ status: 'COMPLETED' });
    assert.equal(page.records.length, 2);
    const stats = await admin.stats();
    assert.equal(stats.counts.COMPLETED, 2);
    assert.equal(stats.counts.DEAD, 1);
    const requeued = await admin.requeue({ id: failure.id, expectedVersion: dead!.rowVersion, actor: 'package-test', reason: 'Verify exported admin API' });
    assert.equal(requeued.status, 'PENDING');
    assert.equal(requeued.attemptCount, 1);
    assert.equal(requeued.cycleAttemptCount, 0);
    const retryReceipt = await inbox.accept({ ...envelope, consumer: 'pack.retry.v1', messageId: 'helper-retry', payload: { key: 'helper-retry' } });
    await inbox.runOnce();
    assert.equal((await admin.get(retryReceipt.id))?.status, 'RETRYABLE');
    assert.equal(await prisma.effect.count({ where: { id: 'helper-retry' } }), 0);
    const drained = await drainInbox(inbox, admin, [retryReceipt.id], { timeoutMs: 5000 });
    assert.equal(drained[0]?.status, 'COMPLETED');
    assert.equal(drained[0]?.attemptCount, 2);
    assert.equal(retryCalls, 2);
    assert.equal((await prisma.effect.findUniqueOrThrow({ where: { id: 'helper-retry' } })).value, 1);
    assert.equal((await waitForInboxRecord(admin, retryReceipt.id)).id, retryReceipt.id);
    console.log('Packed consumer: types, optional tenancy adapter, SQL exports, dedupe, replay lineage, same-tx rollback, scoped admin, and testing helpers passed.');
  } finally {
    await inbox?.close();
    await prisma.$disconnect();
    await pool.end();
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
`,
  );
  await writeFile(
    join(directory, "esm-smoke.mjs"),
    String.raw`
import assert from 'node:assert/strict';
const api = await import('@nestarc/inbox');
assert.equal(typeof api.InboxService, 'function');
assert.equal(typeof api.InboxModule.forRoot, 'function');
assert.equal(typeof api.InboxPermanentError, 'function');
assert.equal(typeof api.InboxReplayConflictError, 'function');
assert.equal(typeof api.createInboxTenancyContext, 'function');
const testing = await import('@nestarc/inbox/testing');
assert.equal(typeof testing.drainInbox, 'function');
assert.equal(typeof testing.waitForInboxRecord, 'function');
assert.equal(typeof testing.InboxTestError, 'function');
console.log('Packed consumer: dynamic ESM import passed.');
`,
  );

  await run(process.execPath, [
    join(directory, "node_modules/prisma/build/index.js"),
    "generate",
    "--config",
    "prisma.config.ts",
  ]);
  await run(process.execPath, [
    join(directory, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.json",
  ]);
  await run(process.execPath, ["consumer.js"]);
  await run(process.execPath, ["esm-smoke.mjs"]);

  const installed = join(directory, "node_modules/@nestarc/inbox");
  const installedManifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  await readFile(join(installed, installedManifest.types), "utf8");
  await inspectInstalledFiles(installed);
  successMessage = `Installed @nestarc/inbox ${installedManifest.version} tarball verification passed.`;
} finally {
  try {
    await verifyCandidateAfterTests();
  } finally {
    // directory is the unique mkdtemp path created by this invocation, never user input.
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(successMessage);
