import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// Benchmarks truncate their fixture tables. Never use an application's DB here.
const databaseUrl = process.env.INBOX_TEST_DATABASE_URL;
const databaseName = process.env.INBOX_TEST_DATABASE_NAME;
if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  !databaseUrl ||
  process.env.DATABASE_URL !== databaseUrl ||
  !/^nestarc_inbox_test_[0-9a-f]{16}$/.test(databaseName ?? "")
) {
  throw new Error("Run benchmark.mjs through scripts/with-test-db.mjs.");
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
  throw new Error("Refusing benchmark writes outside the disposable fixture.");
}

const root = fileURLToPath(new URL("../", import.meta.url));
// Keep stdout exclusively for the JSON report (the outer DB runner logs setup).
execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", 2, 2] });
const require = createRequire(import.meta.url);
const { InboxService } = require("@nestarc/inbox");
const { PrismaClient } = require("../test/prisma/generated");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const connections = 12;
const concurrency = 8;
const workerConcurrency = 4;
const iterations = 500;
const retainedRows = 10_000;
const payload = { orderId: 123, body: "x".repeat(240) };
const observerErrors = {};
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl, max: connections }),
});
let inbox;
const round = (value) => Math.round(value * 1000) / 1000;
function percentile(sorted, fraction) {
  return round(
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0,
  );
}

async function prepare(retained) {
  await pool.query(
    "TRUNCATE public.nestarc_inbox, public.inbox_benchmark_effect",
  );
  if (retained > 0) {
    // Seed completed tombstones directly so data preparation is not timed.
    await pool.query(
      `
      INSERT INTO public.nestarc_inbox
        (id,scope_kind,scope_id,source,consumer,message_id,event_type,schema_version,
         payload,payload_purged,fingerprint,fingerprint_version,status,completed_at)
      SELECT gen_random_uuid(),'global','','benchmark','benchmark.v1','retained-' || n,
        'benchmark.received',1,NULL,true,repeat('0',64),1,'COMPLETED',clock_timestamp()
      FROM generate_series(1,$1::integer) AS n`,
      [retained],
    );
  }
  await pool.query("ANALYZE public.nestarc_inbox");
  // Establish the client pool before measurement without adding inbox records.
  await Promise.all(
    Array.from({ length: concurrency }, () =>
      prisma.$queryRawUnsafe("SELECT 1"),
    ),
  );
}

async function scenario(name, retained, uniqueMessages) {
  await prepare(retained);
  const latencies = [];
  const errors = {};
  let accepted = 0;
  let duplicates = 0;
  let next = 0;
  const beforeErrors = { ...observerErrors };
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const operation = next++;
        if (operation >= iterations) return;
        const start = performance.now();
        try {
          const receipt = await inbox.accept({
            scope: { kind: "global" },
            source: "benchmark",
            consumer: "benchmark.v1",
            messageId: `message-${operation % uniqueMessages}`,
            eventType: "benchmark.received",
            schemaVersion: 1,
            payload,
          });
          if (receipt.kind === "accepted") accepted++;
          else duplicates++;
        } catch (error) {
          const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
          errors[code] = (errors[code] ?? 0) + 1;
        } finally {
          latencies.push(performance.now() - start);
        }
      }
    }),
  );
  const acceptElapsed = performance.now() - started;
  const workerStarted = performance.now();
  let batches = 0;
  while ((await inbox.runOnce()) > 0) {
    batches++;
    if (batches > iterations)
      throw new Error("Unexpectedly unbounded benchmark worker drain.");
  }
  const workerElapsed = performance.now() - workerStarted;
  latencies.sort((a, b) => a - b);
  const stats = await inbox.admin.forGlobal().stats();
  const effects = Number(
    (
      await pool.query(
        "SELECT count(*) AS count FROM public.inbox_benchmark_effect",
      )
    ).rows[0].count,
  );
  const workerErrors = Object.fromEntries(
    Object.entries(observerErrors)
      .map(([code, count]) => [code, count - (beforeErrors[code] ?? 0)])
      .filter(([, count]) => count > 0),
  );
  const valid =
    Object.keys(errors).length === 0 &&
    Object.keys(workerErrors).length === 0 &&
    accepted === uniqueMessages &&
    duplicates === iterations - uniqueMessages &&
    effects === uniqueMessages &&
    stats.counts.COMPLETED === retained + uniqueMessages &&
    stats.counts.PENDING === 0 &&
    stats.counts.PROCESSING === 0 &&
    stats.counts.RETRYABLE === 0 &&
    stats.counts.DEAD === 0;
  return {
    name,
    retainedCompletedReceipts: retained,
    iterations,
    expectedUniqueMessages: uniqueMessages,
    duplicateRatio: round((iterations - uniqueMessages) / iterations),
    accepted,
    duplicates,
    accept: {
      elapsedMs: round(acceptElapsed),
      requestsPerSecond: round(iterations / (acceptElapsed / 1000)),
      latencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        p99: percentile(latencies, 0.99),
      },
    },
    worker: {
      drainMs: round(workerElapsed),
      completedPerSecond: round(effects / (workerElapsed / 1000)),
      batches,
      committedEffects: effects,
    },
    errors: { accept: errors, worker: workerErrors },
    verified: valid,
  };
}

try {
  await pool.query(
    await readFile(
      require.resolve("@nestarc/inbox/sql/create-inbox-table.sql"),
      "utf8",
    ),
  );
  await pool.query(
    "CREATE TABLE public.inbox_benchmark_effect (id text PRIMARY KEY)",
  );
  inbox = new InboxService({
    prisma,
    handlers: [
      {
        consumer: "benchmark.v1",
        eventType: "benchmark.received",
        schemaVersion: 1,
        async handle(_payload, { tx, messageId }) {
          await tx.$executeRawUnsafe(
            "INSERT INTO public.inbox_benchmark_effect (id) VALUES ($1)",
            messageId,
          );
        },
      },
    ],
    worker: { enabled: false, concurrency: workerConcurrency, maxAttempts: 1 },
    observer(event) {
      if (["error", "dead", "retry", "lease_lost"].includes(event.type)) {
        const code = event.code ?? event.type;
        observerErrors[code] = (observerErrors[code] ?? 0) + 1;
      }
    },
  });
  await inbox.initialize();
  const pgVersion = (await pool.query("SELECT version() AS version")).rows[0]
    .version;
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const scenarios = [];
  scenarios.push(await scenario("fresh_unique", 0, iterations));
  scenarios.push(
    await scenario("retained_10000_unique", retainedRows, iterations),
  );
  scenarios.push(
    await scenario("retained_10000_duplicates_90pct", retainedRows, 50),
  );
  console.log(
    JSON.stringify(
      {
        kind: "nestarc-inbox-local-baseline",
        measuredAt: new Date().toISOString(),
        packageVersion: manifest.version,
        metadata: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpuModel: cpus()[0]?.model,
          hostLogicalCpus: cpus().length,
          postgres: pgVersion,
          image: process.env.INBOX_TEST_POSTGRES_IMAGE ?? "postgres:16-alpine",
          storage: "Docker tmpfs; loopback forwarded TCP",
          prisma: manifest.devDependencies["@prisma/client"],
          connectionMax: connections,
          fixtureAdminConnectionMax: 2,
          acceptConcurrency: concurrency,
          workerConcurrency,
          iterationsPerScenario: iterations,
          payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
          retainedPayloads: "purged tombstones",
          warmup:
            "SELECT 1 at accept concurrency before each scenario; no warmup inbox writes",
          workerEffect:
            "One INSERT through the same Prisma transaction as inbox completion",
        },
        scenarios,
        limitations: [
          "One local sample on a disposable tmpfs database; no SLA or production capacity claim.",
          "Scenarios run in a fixed order; later scenarios may benefit from JIT/cache warmup.",
          "No sustained load, network faults, broker traffic, cold-cache runs, or fairness measurement.",
          "Receipt seed and schema preparation are excluded from measurements.",
        ],
      },
      null,
      2,
    ),
  );
  if (scenarios.some((result) => !result.verified)) process.exitCode = 1;
} finally {
  await inbox?.close();
  await prisma.$disconnect();
  await pool.end();
}
