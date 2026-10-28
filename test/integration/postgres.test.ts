import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "../prisma/generated";
import {
  InboxBackpressureError,
  InboxConflictError,
  InboxLeaseLostError,
  InboxSchemaError,
  InboxStateConflictError,
} from "../../src/contracts/errors";
import type {
  InboxPrismaClient,
  InboxTransaction,
} from "../../src/contracts/types";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import { InboxWorker } from "../../src/worker/inbox-worker";
import {
  consumer,
  createFixture,
  deferred,
  envelope,
  runOptions,
  tenant,
  workerOptions,
  wrapTransactions,
  writeEffects,
} from "./fixture";

describe("PostgreSQL transactional inbox contracts", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => {
    fixture = await createFixture();
  }, 30_000);
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it("AC01 accepts 100 concurrent duplicates once and commits one set of effects", async () => {
    const message = envelope();
    const receipts = await Promise.all(
      Array.from({ length: 100 }, () => fixture.storage.accept(message)),
    );
    expect(receipts.filter((r) => r.kind === "accepted")).toHaveLength(1);
    expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
    const claims = (
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          fixture.storage.claim([consumer], 4, `worker-${i}`, 5_000, 3),
        ),
      )
    ).flat();
    expect(claims).toHaveLength(1);
    await fixture.storage.run(
      claims[0]!,
      (tx) => writeEffects(tx, claims[0]!.id),
      runOptions,
    );
    expect(await fixture.effects(claims[0]!.id)).toEqual({
      business: 1,
      outbox: 1,
    });
    expect((await fixture.storage.get(claims[0]!.id))?.status).toBe(
      "COMPLETED",
    );
  }, 20_000);

  it("AC02 isolates tenant, global, source, and logical consumer identities", async () => {
    const variants = [
      envelope({ messageId: "same" }),
      envelope({
        messageId: "same",
        scope: { kind: "tenant", id: "tenant-b" },
      }),
      envelope({ messageId: "same", scope: { kind: "global" } }),
      envelope({ messageId: "same", source: "other-provider-account" }),
      envelope({ messageId: "same", consumer: "notifications.v1" }),
    ];
    const receipts = await Promise.all(
      variants.map((v) => fixture.storage.accept(v)),
    );
    expect(new Set(receipts.map((r) => r.id)).size).toBe(5);
    expect((await fixture.storage.accept(variants[2]!)).kind).toBe("duplicate");
    expect(
      (await fixture.storage.list({}, { kind: "global" })).records,
    ).toHaveLength(1);
  });

  it.each(["PENDING", "DEAD", "COMPLETED"] as const)(
    "AC03 preserves a %s record on identity/content conflict",
    async (state) => {
      const message = envelope();
      const receipt = await fixture.storage.accept(message);
      if (state !== "PENDING") {
        const [claimed] = await fixture.storage.claim(
          [consumer],
          1,
          "worker-a",
          5_000,
          3,
        );
        if (state === "COMPLETED")
          await fixture.storage.run(claimed!, async () => {}, runOptions);
        else
          await fixture.storage.fail(
            claimed!.id,
            claimed!.claimToken,
            { code: "PERMANENT", message: "Rejected." },
            true,
            0,
            3,
          );
      }
      const before = await fixture.storage.get(receipt.id);
      await expect(
        fixture.storage.accept(
          envelope({ messageId: message.messageId, payload: { amount: 999 } }),
        ),
      ).rejects.toBeInstanceOf(InboxConflictError);
      expect(await fixture.storage.get(receipt.id)).toEqual(before);
    },
  );

  it("AC04 rolls back generated Prisma model writes and follow-on events with handler failure", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await expect(
      fixture.storage.run(
        claimed!,
        async (tx) => {
          await (tx as Prisma.TransactionClient).probe.create({
            data: { id: "probe-rollback", value: 1 },
          });
          await writeEffects(tx, claimed!.id);
          throw new Error("handler failed");
        },
        runOptions,
      ),
    ).rejects.toThrow("handler failed");
    expect(await fixture.prisma.probe.count()).toBe(0);
    expect(await fixture.effects(claimed!.id)).toEqual({});
    expect(
      await fixture.storage.fail(
        claimed!.id,
        claimed!.claimToken,
        { code: "HANDLER_ERROR", message: "Message processing failed." },
        false,
        200,
        3,
      ),
    ).toBe(true);
    const after = await fixture.storage.get(claimed!.id);
    expect(after?.status).toBe("RETRYABLE");
    expect(after?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("AC07 rolls back all stale-worker writes after a competing claim acquires a newer token", async () => {
    await fixture.storage.accept(envelope());
    const [old] = await fixture.storage.claim(
      [consumer],
      1,
      "old-worker",
      5_000,
      3,
    );
    const entered = deferred();
    const release = deferred();
    const oldRun = fixture.storage.run(
      old!,
      async (tx) => {
        await writeEffects(tx, old!.id);
        entered.resolve();
        await release.promise;
      },
      runOptions,
    );
    const oldOutcome = oldRun.then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    await fixture.expire(old!.id);
    const [fresh] = await fixture.storage.claim(
      [consumer],
      1,
      "new-worker",
      5_000,
      3,
    );
    expect(BigInt(fresh!.claimToken)).toBeGreaterThan(BigInt(old!.claimToken));
    release.resolve();
    expect(await oldOutcome).toBeInstanceOf(InboxLeaseLostError);
    expect(await fixture.effects(old!.id)).toEqual({});
    await fixture.storage.run(
      fresh!,
      (tx) => writeEffects(tx, fresh!.id),
      runOptions,
    );
    expect(await fixture.effects(old!.id)).toEqual({ business: 1, outbox: 1 });
  });

  it("AC08 protects a completed CAS with the row lock until commit even after lease expiry", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      200,
      3,
    );
    const beforeCommit = deferred();
    const releaseCommit = deferred();
    const wrapped = wrapTransactions(
      fixture.prisma,
      async <T>(
        fn: (tx: InboxTransaction) => Promise<T>,
        options?: Parameters<InboxPrismaClient["$transaction"]>[1],
      ) =>
        fixture.prisma.$transaction(async (tx) => {
          const value = await fn(tx);
          beforeCommit.resolve();
          await releaseCommit.promise;
          return value;
        }, options),
    );
    const storage = new PrismaInboxStorage(wrapped);
    const running = storage.run(
      claimed!,
      (tx) => writeEffects(tx, claimed!.id),
      runOptions,
    );
    const outcome = running.then(
      () => null,
      (error: unknown) => error,
    );
    await beforeCommit.promise;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      await fixture.storage.claim([consumer], 1, "worker-b", 5_000, 3),
    ).toEqual([]);
    releaseCommit.resolve();
    expect(await outcome).toBeNull();
    expect(
      await fixture.storage.claim([consumer], 1, "worker-b", 5_000, 3),
    ).toEqual([]);
    expect(await fixture.effects(claimed!.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });

  it("AC09 reconciles a lost commit response without turning completed work into a retry", async () => {
    const receipt = await fixture.storage.accept(envelope());
    let lost = false;
    const wrapped = wrapTransactions(
      fixture.prisma,
      async <T>(
        fn: (tx: InboxTransaction) => Promise<T>,
        options?: Parameters<InboxPrismaClient["$transaction"]>[1],
      ) => {
        let completed = false;
        const value = await fixture.prisma.$transaction(async (tx) => {
          const observingTx: InboxTransaction = {
            $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
            $executeRawUnsafe: async (query, ...values) => {
              const rows = await tx.$executeRawUnsafe(query, ...values);
              if (query.includes("status='COMPLETED'") && rows === 1)
                completed = true;
              return rows;
            },
          };
          return fn(observingTx);
        }, options);
        if (completed && !lost) {
          lost = true;
          throw new Error("Injected lost COMMIT response");
        }
        return value;
      },
    );
    const worker = new InboxWorker(
      new PrismaInboxStorage(wrapped),
      [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          handle: async (_payload, ctx) => writeEffects(ctx.tx, ctx.inboxId),
        },
      ],
      workerOptions(),
    );
    try {
      expect(await worker.tick()).toBe(1);
    } finally {
      await worker.stop();
    }
    expect(lost).toBe(true);
    expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
    expect(await fixture.effects(receipt.id)).toEqual({
      business: 1,
      outbox: 1,
    });
  });

  it("AC10 counts abandoned claims against the attempt budget and keeps other consumers untouched", async () => {
    const own = await fixture.storage.accept(envelope());
    const foreign = await fixture.storage.accept(
      envelope({ consumer: "other.v1" }),
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [claimed] = await fixture.storage.claim(
        [consumer],
        1,
        "worker-a",
        5_000,
        3,
      );
      expect(claimed?.attemptCount).toBe(attempt);
      await fixture.expire(own.id);
    }
    expect(
      await fixture.storage.claim([consumer], 1, "worker-a", 5_000, 3),
    ).toEqual([]);
    expect((await fixture.storage.get(own.id))?.status).toBe("DEAD");
    expect((await fixture.storage.get(foreign.id))?.status).toBe("PENDING");
  });

  it("AC11 and AC25 allow one requeue and reject stale heartbeats and failures after it", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await fixture.storage.fail(
      claimed!.id,
      claimed!.claimToken,
      { code: "BAD", message: "Rejected." },
      true,
      0,
      3,
    );
    const dead = (await fixture.storage.get(claimed!.id))!;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        fixture.storage.requeue(
          dead.id,
          tenant,
          dead.rowVersion,
          "Configuration repaired",
          "operator",
        ),
      ),
    );
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    const after = (await fixture.storage.get(dead.id))!;
    expect(after).toMatchObject({
      status: "PENDING",
      claimToken: dead.claimToken,
      attemptCount: 1,
      cycleAttemptCount: 0,
      requeueCount: 1,
      lastRequeueActor: "operator",
    });
    expect(
      await fixture.storage.heartbeat(dead.id, claimed!.claimToken, 5_000),
    ).toBe(false);
    expect(
      await fixture.storage.fail(
        dead.id,
        claimed!.claimToken,
        { code: "OLD", message: "Old failure." },
        true,
        0,
        3,
      ),
    ).toBe(false);
    expect((await fixture.storage.get(dead.id))?.status).toBe("PENDING");
  });

  it("AC12 rejects requeue of a completed record", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await fixture.storage.run(claimed!, async () => {}, runOptions);
    const completed = (await fixture.storage.get(claimed!.id))!;
    await expect(
      fixture.storage.requeue(
        completed.id,
        tenant,
        completed.rowVersion,
        "No",
        "operator",
      ),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
  });

  it("AC13 quarantines an unsupported owned schema while leaving foreign consumers pending", async () => {
    const own = await fixture.storage.accept(envelope({ schemaVersion: 2 }));
    const foreign = await fixture.storage.accept(
      envelope({ consumer: "other.v1" }),
    );
    let calls = 0;
    const worker = new InboxWorker(
      fixture.storage,
      [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          handle: async () => {
            calls++;
          },
        },
      ],
      workerOptions(),
    );
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    expect(calls).toBe(0);
    expect(await fixture.storage.get(own.id)).toMatchObject({
      status: "DEAD",
      lastErrorCode: "UNSUPPORTED_MESSAGE",
    });
    expect((await fixture.storage.get(foreign.id))?.status).toBe("PENDING");
  });

  it("AC14 scopes reads, requeues, pagination, and stats to the selected tenant", async () => {
    const first = await fixture.storage.accept(envelope());
    await fixture.storage.accept(
      envelope({ scope: { kind: "tenant", id: "tenant-b" } }),
    );
    await fixture.storage.accept(envelope());
    expect(
      await fixture.storage.get(first.id, { kind: "tenant", id: "tenant-b" }),
    ).toBeNull();
    const pages = await fixture.storage.list({ limit: 1 }, tenant);
    expect(pages.records).toHaveLength(1);
    expect(pages.nextCursor).not.toBeNull();
    const next = await fixture.storage.list(
      { limit: 1, cursor: pages.nextCursor! },
      tenant,
    );
    expect(next.records).toHaveLength(1);
    expect(next.records[0]?.id).not.toBe(pages.records[0]?.id);
    expect(next.nextCursor).toBeNull();
    expect((await fixture.storage.stats(tenant)).counts.PENDING).toBe(2);
    await expect(
      fixture.storage.requeue(
        first.id,
        { kind: "tenant", id: "tenant-b" },
        "1",
        "Wrong scope",
        "operator",
      ),
    ).rejects.toBeInstanceOf(InboxStateConflictError);
  });

  it("AC15 and AC16 purge only completed payloads while preserving dedupe and every recoverable payload", async () => {
    const original = envelope({ payload: null });
    const complete = await fixture.storage.accept(original);
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await fixture.storage.run(claimed!, async () => {}, runOptions);
    const pending = await fixture.storage.accept(envelope());
    const processing = await fixture.storage.accept(
      envelope({ consumer: "processing.v1" }),
    );
    const [active] = await fixture.storage.claim(
      ["processing.v1"],
      1,
      "worker-b",
      5_000,
      3,
    );
    const retry = await fixture.storage.accept(
      envelope({ consumer: "retry.v1" }),
    );
    const [retryClaim] = await fixture.storage.claim(
      ["retry.v1"],
      1,
      "worker-c",
      5_000,
      3,
    );
    await fixture.storage.fail(
      retry.id,
      retryClaim!.claimToken,
      { code: "ERR", message: "Retry." },
      false,
      0,
      3,
    );
    const dead = await fixture.storage.accept(
      envelope({ consumer: "dead.v1" }),
    );
    const [deadClaim] = await fixture.storage.claim(
      ["dead.v1"],
      1,
      "worker-d",
      5_000,
      3,
    );
    await fixture.storage.fail(
      dead.id,
      deadClaim!.claimToken,
      { code: "ERR", message: "Dead." },
      true,
      0,
      3,
    );
    expect(active?.id).toBe(processing.id);
    expect(
      await fixture.storage.purgeCompletedPayload(
        new Date(Date.now() + 1_000),
        100,
        tenant,
      ),
    ).toBe(1);
    expect(await fixture.storage.get(complete.id)).toMatchObject({
      status: "COMPLETED",
      payloadPurged: true,
      fingerprint: original.fingerprint,
    });
    expect(await fixture.storage.accept(original)).toMatchObject({
      kind: "duplicate",
      id: complete.id,
      status: "COMPLETED",
    });
    for (const id of [pending.id, processing.id, retry.id, dead.id]) {
      expect((await fixture.storage.get(id))?.payloadPurged).toBe(false);
    }
  });

  it("AC17 isolates failing observation hooks from committed results and excludes payload content", async () => {
    const receipt = await fixture.storage.accept(
      envelope({ payload: { secret: "private-payload" } }),
    );
    const events: unknown[] = [];
    const worker = new InboxWorker(
      fixture.storage,
      [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          handle: async (_payload, ctx) => writeEffects(ctx.tx, ctx.inboxId),
        },
      ],
      workerOptions(),
      (event) => {
        events.push(event);
        return Promise.reject(new Error("observer down"));
      },
    );
    try {
      await worker.tick();
    } finally {
      await worker.stop();
    }
    expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
    expect(events).toContainEqual({ type: "completed", consumer });
    expect(JSON.stringify(events)).not.toContain("private-payload");
    expect(JSON.stringify(events)).not.toContain("tenant-a");
  });

  it("AC19 keeps duplicate receipts available when admission is full", async () => {
    const storage = new PrismaInboxStorage(fixture.prisma, {
      maxPendingMessages: 1,
    });
    const original = envelope();
    const receipt = await storage.accept(original);
    await expect(storage.accept(envelope())).rejects.toBeInstanceOf(
      InboxBackpressureError,
    );
    expect(await storage.accept(original)).toMatchObject({
      kind: "duplicate",
      id: receipt.id,
    });
    expect((await storage.stats()).counts.PENDING).toBe(1);
  });

  it("AC21 and AC23 claim only available slots and leave unowned backlog visible", async () => {
    await Promise.all(
      Array.from({ length: 4 }, () => fixture.storage.accept(envelope())),
    );
    const unowned = await fixture.storage.accept(
      envelope({ consumer: "unowned.v1" }),
    );
    const batch = await fixture.storage.claim(
      [consumer],
      2,
      "worker-a",
      5_000,
      3,
    );
    expect(batch).toHaveLength(2);
    const stats = await fixture.storage.stats();
    expect(stats.counts.PROCESSING).toBe(2);
    expect(stats.counts.PENDING).toBe(3);
    expect(stats.oldestPendingAt).toBeInstanceOf(Date);
    expect((await fixture.storage.get(unowned.id))?.status).toBe("PENDING");
  });

  it("AC22 closes timed-out transactions so an ignored deadline cannot write later", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    const continueLate = deferred();
    const lateResult = deferred<unknown>();
    await expect(
      fixture.storage.run(
        claimed!,
        async (tx) => {
          await writeEffects(tx, claimed!.id);
          await continueLate.promise;
          try {
            await writeEffects(tx, claimed!.id);
            lateResult.resolve(null);
          } catch (error) {
            lateResult.resolve(error);
            throw error;
          }
        },
        { ...runOptions, timeoutMs: 100 },
      ),
    ).rejects.toBeDefined();
    continueLate.resolve();
    expect(await lateResult.promise).toBeInstanceOf(Error);
    expect(await fixture.effects(claimed!.id)).toEqual({});
    expect((await fixture.storage.get(claimed!.id))?.status).toBe("PROCESSING");
  });

  it("AC22 rolls back business writes when a SQL statement exceeds its timeout", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await expect(
      fixture.storage.run(
        claimed!,
        async (tx) => {
          await writeEffects(tx, claimed!.id);
          await tx.$queryRawUnsafe("SELECT pg_sleep(2)");
        },
        { ...runOptions, timeoutMs: 100 },
      ),
    ).rejects.toBeDefined();
    expect(await fixture.effects(claimed!.id)).toEqual({});
  });

  it("AC25 rejects heartbeat and failure after lease expiry before any new claim", async () => {
    await fixture.storage.accept(envelope());
    const [claimed] = await fixture.storage.claim(
      [consumer],
      1,
      "worker-a",
      5_000,
      3,
    );
    await fixture.expire(claimed!.id);
    expect(
      await fixture.storage.heartbeat(claimed!.id, claimed!.claimToken, 5_000),
    ).toBe(false);
    expect(
      await fixture.storage.fail(
        claimed!.id,
        claimed!.claimToken,
        { code: "ERR", message: "Late." },
        false,
        0,
        3,
      ),
    ).toBe(false);
    expect((await fixture.storage.get(claimed!.id))?.status).toBe("PROCESSING");
  });

  it("rejects an incompatible schema version without silently repairing it", async () => {
    await fixture.storage.assertSchema();
    await fixture.pool.query(
      "UPDATE public.nestarc_inbox_schema SET version=999",
    );
    try {
      await expect(fixture.storage.assertSchema()).rejects.toBeInstanceOf(
        InboxSchemaError,
      );
    } finally {
      await fixture.pool.query(
        "UPDATE public.nestarc_inbox_schema SET version=2",
      );
    }
    await fixture.storage.assertSchema();
  });
});
