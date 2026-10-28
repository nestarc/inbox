import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "../prisma/generated";
import { requireTestDatabase } from "../prisma/fixture-guard";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import { normalizeEnvelope } from "../../src/internal/validation";
import type {
  InboxEnvelope,
  InboxPrismaClient,
  InboxTransaction,
  ResolvedWorkerOptions,
} from "../../src/contracts/types";

export const consumer = "orders.projection.v1";
export const tenant = { kind: "tenant", id: "tenant-a" } as const;
export const runOptions = {
  timeoutMs: 3_000,
  maxWaitMs: 1_000,
  lockTimeoutMs: 500,
};

export function envelope(overrides: Partial<InboxEnvelope> = {}) {
  return normalizeEnvelope(
    {
      scope: tenant,
      source: "orders-service",
      consumer,
      messageId: randomUUID(),
      eventType: "order.created",
      schemaVersion: 1,
      payload: { orderId: "order-1", amount: 42 },
      ...overrides,
    },
    [overrides.consumer ?? consumer],
  );
}

export function workerOptions(
  overrides: Partial<ResolvedWorkerOptions> = {},
): ResolvedWorkerOptions {
  return {
    enabled: true,
    consumers: [consumer],
    concurrency: 4,
    pollIntervalMs: 20,
    leaseMs: 5_000,
    heartbeatIntervalMs: 100,
    transactionTimeoutMs: 2_000,
    transactionMaxWaitMs: 1_000,
    lockTimeoutMs: 500,
    shutdownTimeoutMs: 2_500,
    maxAttempts: 3,
    retryBaseMs: 1,
    retryMaxMs: 2,
    ...overrides,
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function createFixture(migrate = true) {
  const connectionString = requireTestDatabase();
  const pool = new Pool({ connectionString, max: 5 });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, max: 30 }),
  });
  await prisma.$connect();
  if (migrate) {
    const sql = await readFile(
      resolve("src/sql/create-inbox-table.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(`CREATE TABLE IF NOT EXISTS public.inbox_test_effects (
      id uuid PRIMARY KEY, inbox_id uuid NOT NULL, kind text NOT NULL
    );
    CREATE TABLE IF NOT EXISTS public.inbox_test_probe (
      id text PRIMARY KEY, value integer NOT NULL DEFAULT 0
    )`);
  }
  const storage = new PrismaInboxStorage(prisma);
  return {
    prisma,
    pool,
    storage,
    async reset() {
      requireTestDatabase();
      await pool.query(
        "TRUNCATE public.nestarc_inbox, public.inbox_test_effects, public.inbox_test_probe",
      );
    },
    async effects(id: string) {
      const result = await pool.query<{ kind: string; count: string }>(
        "SELECT kind,count(*)::text AS count FROM public.inbox_test_effects WHERE inbox_id=$1::uuid GROUP BY kind",
        [id],
      );
      return Object.fromEntries(
        result.rows.map((row) => [row.kind, Number(row.count)]),
      );
    },
    async expire(id: string) {
      await pool.query(
        `UPDATE public.nestarc_inbox SET lease_expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1::uuid AND status='PROCESSING'`,
        [id],
      );
    },
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

export async function writeEffects(tx: InboxTransaction, inboxId: string) {
  for (const kind of ["business", "outbox"]) {
    await tx.$executeRawUnsafe(
      "INSERT INTO public.inbox_test_effects(id,inbox_id,kind) VALUES($1::uuid,$2::uuid,$3)",
      randomUUID(),
      inboxId,
      kind,
    );
  }
}

/** Fault-injection seam around a real Prisma transaction, never a simulated database. */
export function wrapTransactions(
  prisma: InboxPrismaClient,
  transaction: InboxPrismaClient["$transaction"],
): InboxPrismaClient {
  return {
    $queryRawUnsafe: prisma.$queryRawUnsafe.bind(prisma),
    $executeRawUnsafe: prisma.$executeRawUnsafe.bind(prisma),
    $transaction: transaction,
  };
}

export async function waitForLeaseExpiry(
  storage: PrismaInboxStorage,
  id: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const record = await storage.get(id);
    if (
      record?.leaseExpiresAt &&
      record.leaseExpiresAt.getTime() < Date.now() - 20
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("Test lease failed to expire within five seconds.");
}
