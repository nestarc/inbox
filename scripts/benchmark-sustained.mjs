import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const databaseUrl = process.env.INBOX_TEST_DATABASE_URL;
const databaseName = process.env.INBOX_TEST_DATABASE_NAME;
if (
  process.env.INBOX_TEST_DATABASE !== "1" ||
  process.env.INBOX_BENCHMARK_DISK_FIXTURE !== "1" ||
  !databaseUrl ||
  process.env.DATABASE_URL !== databaseUrl ||
  !/^nestarc_inbox_test_[0-9a-f]{16}$/.test(databaseName ?? "")
)
  throw new Error(
    "Run through scripts/with-benchmark-db.mjs; application databases are forbidden.",
  );
const url = new URL(databaseUrl);
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "127.0.0.1" ||
  !url.port ||
  url.username !== "inbox_test" ||
  url.pathname !== `/${databaseName}` ||
  url.search ||
  url.hash
)
  throw new Error(
    "Refusing benchmark writes outside the disposable loopback fixture.",
  );

function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
const durationSeconds = integer("INBOX_BENCHMARK_SECONDS", 120, 10, 300);
const recoverySeconds = integer(
  "INBOX_BENCHMARK_RECOVERY_SECONDS",
  180,
  10,
  300,
);
const retainedRows = integer("INBOX_BENCHMARK_RETAINED", 5_000, 0, 50_000);
const require = createRequire(import.meta.url);
const { InboxService } = require("@nestarc/inbox");
const { PrismaClient } = require("../test/prisma/generated");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: databaseUrl,
  max: 8,
  connectionTimeoutMillis: 10_000,
});
const admin = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: 10_000,
});
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const round = (n) => Math.round(Number(n) * 1000) / 1000;
const percentile = (values, fraction) =>
  values.length
    ? round(
        [...values].sort((a, b) => a - b)[
          Math.max(0, Math.ceil(values.length * fraction) - 1)
        ],
      )
    : 0;
const distribution = (values) => ({
  count: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: round(values.reduce((max, value) => Math.max(max, value), 0)),
});
const acquireLatencies = [];
const originalConnect = pool.connect.bind(pool);
pool.connect = function (callback) {
  const start = performance.now();
  if (typeof callback === "function")
    return originalConnect((error, client, release) => {
      acquireLatencies.push(performance.now() - start);
      callback(error, client, release);
    });
  return originalConnect().then((client) => {
    acquireLatencies.push(performance.now() - start);
    return client;
  });
};
const payloads = Array.from({ length: 64 }, () =>
  randomBytes(768).toString("base64"),
);
const events = {};
const errors = {};
const acceptanceLatencies = [];
const samples = [];
const probes = [];
const pressureClients = [];
const stop = new AbortController();
let inbox;
let processing = true;
let sampling = true;
let workerTask;
let sampleTask;
let pressureTask;
let attempted = 0;
let accepted = 0;
let duplicate = 0;
let expectedRetries = 0;
let pressureStartedMs;
let pressureEndedMs;
let phaseStarted = performance.now();

async function storageSize() {
  const {
    rows: [result],
  } = await admin.query(`SELECT
    count(*)::int AS receipts,
    count(*) FILTER (WHERE payload_purged)::int AS purged,
    coalesce(sum(pg_column_size(payload)), 0)::bigint::text AS payload_bytes,
    pg_relation_size('public.nestarc_inbox')::text AS heap_bytes,
    pg_indexes_size('public.nestarc_inbox')::text AS index_bytes,
    pg_total_relation_size('public.nestarc_inbox')::text AS total_bytes
    FROM public.nestarc_inbox`);
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, Number(value)]),
  );
}

async function snapshot() {
  const {
    rows: [result],
  } = await admin.query(`SELECT
    count(*) FILTER (WHERE status IN ('PENDING','PROCESSING','RETRYABLE'))::int AS backlog,
    count(*) FILTER (WHERE status='COMPLETED')::int AS completed,
    count(*) FILTER (WHERE status='DEAD')::int AS dead,
    coalesce(extract(epoch FROM (clock_timestamp() - min(received_at) FILTER
      (WHERE status IN ('PENDING','PROCESSING','RETRYABLE')))) * 1000, 0)::float8 AS oldest_pending_ms
    FROM public.nestarc_inbox WHERE source='sustained-benchmark'`);
  return {
    elapsedMs: round(performance.now() - phaseStarted),
    ...result,
    oldest_pending_ms: round(result.oldest_pending_ms),
    poolWaiting: pool.waitingCount,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    accepted,
  };
}

function expectedAt(seconds) {
  const quarter = durationSeconds / 4;
  return Math.floor(
    Math.min(seconds, quarter) * 80 +
      Math.max(0, Math.min(seconds - quarter, durationSeconds / 2)) * 240 +
      Math.max(0, Math.min(seconds - quarter * 3, quarter)) * 80,
  );
}

function shouldRetry(index) {
  const tenantIndex =
    index % 20 === 0 ? index / 20 : index - Math.floor(index / 20) - 1;
  return tenantIndex % 50 === 0;
}

async function submit(index) {
  const envelope = {
    scope: { kind: "tenant", id: index % 20 === 0 ? "cold" : "hot" },
    source: "sustained-benchmark",
    consumer: "benchmark.sustained.v1",
    messageId: `message-${index}`,
    eventType: "benchmark.received",
    schemaVersion: 1,
    payload: { index, body: payloads[index % payloads.length] },
  };
  const start = performance.now();
  try {
    const receipt = await inbox.accept(envelope);
    if (receipt.kind === "accepted") {
      accepted++;
      if (shouldRetry(index)) expectedRetries++;
    } else duplicate++;
    if (probes.length < 40) probes.push({ envelope, receipt });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    errors[code] = (errors[code] ?? 0) + 1;
  } finally {
    acceptanceLatencies.push(performance.now() - start);
  }
}

try {
  await admin.query(
    await readFile(
      require.resolve("@nestarc/inbox/sql/create-inbox-table.sql"),
      "utf8",
    ),
  );
  await admin.query(`CREATE TABLE public.inbox_benchmark_effect (
    effect_id bigserial PRIMARY KEY, inbox_id uuid NOT NULL,
    tenant text NOT NULL, message_id text NOT NULL)`);
  await admin.query("CREATE INDEX ON public.inbox_benchmark_effect (inbox_id)");
  const emptyStorage = await storageSize();
  await admin.query(
    `INSERT INTO public.nestarc_inbox
    (id,scope_kind,scope_id,source,consumer,message_id,event_type,schema_version,payload,
      fingerprint,fingerprint_version,status,completed_at)
    SELECT gen_random_uuid(),'tenant','retained','seed','benchmark.sustained.v1',n::text,
      'benchmark.received',1,jsonb_build_object('body',$2::text),repeat('0',64),1,
      'COMPLETED',clock_timestamp() - interval '1 day'
    FROM generate_series(1,$1::integer) AS n`,
    [retainedRows, payloads[0]],
  );
  await admin.query("ANALYZE public.nestarc_inbox");
  const seededStorage = await storageSize();
  inbox = new InboxService({
    prisma,
    privilegedAdmin: true,
    handlers: [
      {
        consumer: "benchmark.sustained.v1",
        eventType: "benchmark.received",
        schemaVersion: 1,
        async handle(payload, { tx, inboxId, messageId, scope, attempt }) {
          await tx.$queryRawUnsafe("SELECT 1 AS waited FROM pg_sleep(0.015)");
          await tx.$executeRawUnsafe(
            "INSERT INTO public.inbox_benchmark_effect (inbox_id,tenant,message_id) VALUES ($1::uuid,$2,$3)",
            inboxId,
            scope.id,
            messageId,
          );
          if (shouldRetry(payload.index) && attempt === 1)
            throw new Error("Intentional first-attempt rollback");
        },
      },
    ],
    worker: {
      enabled: false,
      concurrency: 4,
      transactionTimeoutMs: 8_000,
      transactionMaxWaitMs: 5_000,
      leaseMs: 20_000,
      heartbeatIntervalMs: 2_000,
      maxAttempts: 5,
      retryBaseMs: 100,
      retryMaxMs: 500,
    },
    observer(event) {
      events[event.type] = (events[event.type] ?? 0) + 1;
    },
  });
  await inbox.initialize();
  await Promise.all(
    Array.from({ length: 8 }, () => prisma.$queryRawUnsafe("SELECT 1")),
  );
  acquireLatencies.length = 0;
  phaseStarted = performance.now();
  workerTask = (async () => {
    while (processing) {
      try {
        if ((await inbox.runOnce()) === 0) await delay(5);
      } catch (error) {
        errors[`worker:${error?.code ?? "UNKNOWN"}`] =
          (errors[`worker:${error?.code ?? "UNKNOWN"}`] ?? 0) + 1;
        await delay(25);
      }
    }
  })();
  sampleTask = (async () => {
    while (sampling) {
      const result = await snapshot();
      samples.push(result);
      if (samples.length % 10 === 0)
        console.error(
          `Benchmark ${Math.round(result.elapsedMs / 1000)}s: accepted=${accepted}, backlog=${result.backlog}, pool-waiting=${result.poolWaiting}`,
        );
      await delay(1000);
    }
  })().catch((error) => {
    errors[`sampler:${error?.code ?? "UNKNOWN"}`] = 1;
  });
  pressureTask = (async () => {
    await delay(durationSeconds * 1000 * 0.4, undefined, {
      signal: stop.signal,
    });
    for (let n = 0; n < 4 && !stop.signal.aborted; n++)
      pressureClients.push(await pool.connect());
    pressureStartedMs = round(performance.now() - phaseStarted);
    await delay(durationSeconds * 1000 * 0.25, undefined, {
      signal: stop.signal,
    });
    for (const client of pressureClients.splice(0)) client.release();
    pressureEndedMs = round(performance.now() - phaseStarted);
  })().catch((error) => {
    if (!stop.signal.aborted)
      errors[`pressure:${error?.code ?? "UNKNOWN"}`] = 1;
  });
  const inFlight = new Set();
  while ((performance.now() - phaseStarted) / 1000 < durationSeconds) {
    const target = expectedAt((performance.now() - phaseStarted) / 1000);
    while (attempted < target && inFlight.size < 16) {
      const task = submit(attempted++);
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    }
    await delay(5);
  }
  await Promise.all(inFlight);
  await pressureTask;
  const ingressEndedMs = performance.now() - phaseStarted;
  const backlogAtIngressEnd = await snapshot();
  const recoveryDeadline = performance.now() + recoverySeconds * 1000;
  let finalSnapshot = backlogAtIngressEnd;
  while (finalSnapshot.backlog > 0 && performance.now() < recoveryDeadline) {
    await delay(250);
    finalSnapshot = await snapshot();
  }
  const recoveredAtMs = performance.now() - phaseStarted;
  processing = false;
  await workerTask;
  sampling = false;
  await sampleTask;
  samples.push(await snapshot());
  const measuredAcquireLatencies = [...acquireLatencies];
  const beforePurge = await storageSize();
  const { rows: tenantLatency } = await admin.query(`SELECT scope_id AS tenant,
    count(*)::int AS completed,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-received_at)*1000) AS p50_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-received_at)*1000) AS p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-received_at)*1000) AS p99_ms,
    max(extract(epoch FROM completed_at-received_at)*1000)::float8 AS max_ms
    FROM public.nestarc_inbox WHERE source='sustained-benchmark' AND status='COMPLETED' GROUP BY scope_id ORDER BY scope_id`);
  const {
    rows: [consistency],
  } = await admin.query(`SELECT
    (SELECT count(*) FROM public.inbox_benchmark_effect)::int AS effects,
    count(*)::int AS receipts,
    count(*) FILTER (WHERE status='COMPLETED')::int AS completed,
    count(*) FILTER (WHERE attempt_count > 1)::int AS retried,
    count(*) FILTER (WHERE status<>'COMPLETED')::int AS incomplete,
    count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM public.inbox_benchmark_effect e WHERE e.inbox_id=i.id))::int AS missing_effect,
    count(*) FILTER (WHERE (SELECT count(*) FROM public.inbox_benchmark_effect e WHERE e.inbox_id=i.id) > 1)::int AS duplicate_effect
    FROM public.nestarc_inbox i WHERE source='sustained-benchmark'`);
  const fingerprintBefore = (
    await admin.query(
      "SELECT md5(string_agg(id::text || fingerprint, '' ORDER BY id)) AS checksum FROM public.nestarc_inbox",
    )
  ).rows[0].checksum;
  const purgeStarted = performance.now();
  let purged = 0;
  for (;;) {
    const count = await inbox.privilegedAdmin.purgeCompletedPayload({
      before: new Date(),
      limit: 500,
    });
    purged += count;
    if (!count) break;
  }
  const purgeMs = performance.now() - purgeStarted;
  const afterPurge = await storageSize();
  await admin.query("VACUUM (ANALYZE) public.nestarc_inbox");
  const afterVacuum = await storageSize();
  const fingerprintAfter = (
    await admin.query(
      "SELECT md5(string_agg(id::text || fingerprint, '' ORDER BY id)) AS checksum FROM public.nestarc_inbox",
    )
  ).rows[0].checksum;
  let duplicateProbes = 0;
  for (const probe of probes) {
    const result = await inbox.accept(probe.envelope);
    if (
      result.kind === "duplicate" &&
      result.id === probe.receipt.id &&
      result.status === "COMPLETED"
    )
      duplicateProbes++;
  }
  const effectsAfterProbes = Number(
    (
      await admin.query(
        "SELECT count(*) AS count FROM public.inbox_benchmark_effect",
      )
    ).rows[0].count,
  );
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const settings = (
    await admin.query(
      "SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','max_connections') ORDER BY name",
    )
  ).rows;
  const verified =
    Object.keys(errors).length === 0 &&
    duplicate === 0 &&
    consistency.receipts === accepted &&
    consistency.effects === accepted &&
    consistency.completed === accepted &&
    consistency.incomplete === 0 &&
    consistency.missing_effect === 0 &&
    consistency.duplicate_effect === 0 &&
    consistency.retried === expectedRetries &&
    fingerprintBefore === fingerprintAfter &&
    purged === retainedRows + accepted &&
    duplicateProbes === probes.length &&
    effectsAfterProbes === accepted &&
    afterPurge.payload_bytes === 0 &&
    samples.some((sample) => sample.poolWaiting > 0) &&
    backlogAtIngressEnd.backlog > 0;
  console.log(
    JSON.stringify(
      {
        kind: "nestarc-inbox-sustained-disk-benchmark",
        measuredAt: new Date().toISOString(),
        packageVersion: manifest.version,
        verified,
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          cpuModel: cpus()[0]?.model,
          logicalCpus: cpus().length,
          postgres: (await admin.query("SELECT version() AS version")).rows[0]
            .version,
          prisma: manifest.devDependencies["@prisma/client"],
          ...JSON.parse(process.env.INBOX_BENCHMARK_ENVIRONMENT),
          settings,
        },
        workload: {
          durationSeconds,
          recoveryLimitSeconds: recoverySeconds,
          retainedRows,
          phaseRatesPerSecond: [80, 240, 80],
          phaseDurationSeconds: [
            durationSeconds / 4,
            durationSeconds / 2,
            durationSeconds / 4,
          ],
          ingressConcurrencyLimit: 16,
          workerConcurrency: 4,
          sharedPoolMax: 8,
          adminPoolMax: 2,
          poolPressure: {
            heldConnections: 4,
            startedMs: pressureStartedMs,
            releasedMs: pressureEndedMs,
          },
          handlerSqlDelayMs: 15,
          intentionalFirstAttemptFailureEveryPerTenant: 50,
          expectedRetries,
          tenantMix: { hot: "95%", cold: "5%" },
          bodyBytes: 1024,
          targetSubmissions: expectedAt(durationSeconds),
          attempted,
          accepted,
          duplicate,
          unsentTargetSubmissions: expectedAt(durationSeconds) - attempted,
        },
        result: {
          ingressMs: round(ingressEndedMs),
          receivePerSecond: round(accepted / (ingressEndedMs / 1000)),
          acceptLatencyMs: distribution(acceptanceLatencies),
          poolAcquireMs: distribution(measuredAcquireLatencies),
          poolQueuedSamples: samples.filter((sample) => sample.poolWaiting > 0)
            .length,
          poolWaitingMax: Math.max(
            ...samples.map((sample) => sample.poolWaiting),
          ),
          peakBacklog: Math.max(...samples.map((sample) => sample.backlog)),
          backlogAtIngressEnd: backlogAtIngressEnd.backlog,
          recoveryMs: round(recoveredAtMs - ingressEndedMs),
          totalProcessingMs: round(recoveredAtMs),
          tenantCompletionLatency: tenantLatency.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                key === "tenant" ? value : round(value),
              ]),
            ),
          ),
          consistency,
          events,
          errors,
        },
        retention: {
          emptyStorage,
          seededStorage,
          beforePurge,
          afterPurge,
          afterVacuum,
          purgeBatchLimit: 500,
          purged,
          purgeMs: round(purgeMs),
          identityFingerprintChecksumPreserved:
            fingerprintBefore === fingerprintAfter,
          duplicateProbes,
          effectsAfterProbes,
        },
        samples,
        limitations: [
          "One local Docker VM, a bounded several-minute workload, and one handler shape; not a production capacity or long-term soak guarantee.",
          "The database uses a disk-backed volume, but host/VM caches and fsync virtualization remain; no controlled cold-cache or physical disk benchmark.",
          "Ingress is bounded and closed-loop under saturation; target and unsent submissions are reported separately from achieved throughput.",
          "Tenant delay observes the current shared scheduling behavior; it does not establish a fairness SLA.",
          "The handler intentionally sleeps 15 ms in SQL and rolls back 2% of first attempts to make backlog and recovery observable.",
          "Payload cleanup retains identity and indexes. Ordinary VACUUM permits reuse and need not return allocated bytes to the filesystem.",
          "No network faults, failover, broker traffic, RLS, or outbox writes in this workload; separate operational tests cover those paths.",
        ],
      },
      null,
      2,
    ),
  );
  if (!verified) process.exitCode = 1;
} finally {
  processing = false;
  sampling = false;
  stop.abort();
  await pressureTask;
  for (const client of pressureClients.splice(0)) client.release();
  await Promise.allSettled([workerTask, sampleTask].filter(Boolean));
  await inbox?.close();
  await prisma.$disconnect();
  await pool.end();
  await admin.end();
}
