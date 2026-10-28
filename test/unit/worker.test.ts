import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InboxConfigurationError,
  InboxLeaseLostError,
  InboxPermanentError,
} from "../../src/contracts/errors";
import type {
  InboxHandler,
  InboxObservation,
  InboxRecord,
  InboxTransaction,
  ResolvedWorkerOptions,
} from "../../src/contracts/types";
import type { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import { InboxWorker } from "../../src/worker/inbox-worker";

function record(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    scope: { kind: "tenant", id: "tenant-a" },
    source: "orders",
    consumer: "projection.v1",
    messageId: "message-1",
    eventType: "order.created",
    schemaVersion: 1,
    payload: { orderId: "order-1" },
    payloadPurged: false,
    fingerprint: "fingerprint",
    fingerprintVersion: 1,
    status: "PROCESSING",
    claimToken: "1",
    rowVersion: "2",
    attemptCount: 1,
    cycleAttemptCount: 1,
    requeueCount: 0,
    receivedAt: new Date(),
    completedAt: null,
    nextAttemptAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 1000),
    workerId: "worker",
    lastErrorCode: null,
    lastErrorMessage: null,
    lastRequeueReason: null,
    lastRequeueActor: null,
    lastRequeueAt: null,
    correlationId: "correlation",
    causationId: "cause",
    ...overrides,
  };
}

function options(
  overrides: Partial<ResolvedWorkerOptions> = {},
): ResolvedWorkerOptions {
  return {
    enabled: true,
    consumers: ["projection.v1"],
    concurrency: 2,
    pollIntervalMs: 50,
    leaseMs: 1000,
    heartbeatIntervalMs: 100,
    transactionTimeoutMs: 500,
    transactionMaxWaitMs: 50,
    lockTimeoutMs: 25,
    shutdownTimeoutMs: 200,
    maxAttempts: 8,
    retryBaseMs: 1000,
    retryMaxMs: 300000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tx = {
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
} as unknown as InboxTransaction;

function fixture(
  row = record(),
  override: Partial<ResolvedWorkerOptions> = {},
) {
  const storage = {
    claim: vi.fn().mockResolvedValue([]).mockResolvedValueOnce([row]),
    run: vi
      .fn()
      .mockImplementation(
        async (
          _row: InboxRecord,
          fn: (tx: InboxTransaction) => Promise<void>,
        ) => fn(tx),
      ),
    heartbeat: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(row),
  };
  const handle = vi.fn().mockResolvedValue(undefined);
  const handler: InboxHandler = {
    consumer: "projection.v1",
    eventType: "order.created",
    schemaVersion: 1,
    handle,
  };
  const events: InboxObservation[] = [];
  const worker = new InboxWorker(
    storage as unknown as PrismaInboxStorage,
    [handler],
    options(override),
    (event) => {
      events.push(event);
    },
  );
  return { storage, handler, handle, events, worker, row };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("InboxWorker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("passes the same transaction and stable envelope context to the handler", async () => {
    const f = fixture();
    expect(await f.worker.tick()).toBe(1);
    expect(f.handle).toHaveBeenCalledWith(
      f.row.payload,
      expect.objectContaining({
        tx,
        scope: f.row.scope,
        messageId: f.row.messageId,
        inboxId: f.row.id,
        source: "orders",
        consumer: "projection.v1",
        attempt: 1,
        correlationId: "correlation",
        causationId: "cause",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(f.storage.run).toHaveBeenCalledWith(f.row, expect.any(Function), {
      timeoutMs: 500,
      maxWaitMs: 50,
      lockTimeoutMs: 25,
    });
    expect(f.events).toEqual([
      { type: "completed", consumer: "projection.v1" },
    ]);
    expect(f.storage.fail).not.toHaveBeenCalled();
    await f.worker.stop();
  });

  it("quarantines an owned consumer with an unsupported event/schema without calling it", async () => {
    const f = fixture(record({ schemaVersion: 2 }));
    await f.worker.tick();
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.storage.run).not.toHaveBeenCalled();
    expect(f.storage.fail).toHaveBeenCalledWith(
      f.row.id,
      "1",
      {
        code: "UNSUPPORTED_MESSAGE",
        message: expect.any(String),
      },
      true,
      expect.any(Number),
      8,
    );
    expect(f.events[0]?.type).toBe("dead");
  });

  it("quarantines invalid payloads and does not persist validator secrets", async () => {
    const f = fixture();
    f.handler.validate = () => {
      throw new Error("customer secret");
    };
    await f.worker.tick();
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.storage.fail.mock.calls[0]?.[2]).toEqual({
      code: "INVALID_PAYLOAD",
      message: "The payload failed consumer validation.",
    });
    expect(JSON.stringify(f.events)).not.toContain("customer secret");
  });

  it("redacts arbitrary handler error messages and uses bounded full jitter", async () => {
    const f = fixture(record({ cycleAttemptCount: 3 }));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    f.handle.mockRejectedValue(new Error("token=secret"));
    await f.worker.tick();
    expect(f.storage.fail).toHaveBeenCalledWith(
      f.row.id,
      "1",
      {
        code: "HANDLER_ERROR",
        message: "Message processing failed.",
      },
      false,
      2000,
      8,
    );
    expect(f.events).toEqual([
      { type: "retry", consumer: "projection.v1", code: "HANDLER_ERROR" },
    ]);
  });

  it("redacts application-provided permanent error messages and codes", async () => {
    const f = fixture();
    f.handle.mockRejectedValue(
      new InboxPermanentError("sensitive payload", "sensitive custom code"),
    );
    await f.worker.tick();
    expect(f.storage.fail.mock.calls[0]?.[2]).toEqual({
      code: "PERMANENT_ERROR",
      message: "The handler rejected the message permanently.",
    });
    expect(f.events[0]?.type).toBe("dead");
  });

  it("reports DEAD for an exhausted attempt budget and caps retry delay", async () => {
    const f = fixture(record({ cycleAttemptCount: 8 }), { retryMaxMs: 1200 });
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    f.handle.mockRejectedValue(new Error("failure"));
    await f.worker.tick();
    expect(f.storage.fail.mock.calls[0]?.[4]).toBeLessThanOrEqual(1200);
    expect(f.events[0]?.type).toBe("dead");
  });

  it("reconciles a lost commit response without overwriting COMPLETED", async () => {
    const f = fixture();
    f.storage.run.mockRejectedValue(new Error("connection lost after commit"));
    f.storage.get.mockResolvedValue(record({ status: "COMPLETED" }));
    await f.worker.tick();
    expect(f.storage.fail).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      { type: "completed", consumer: "projection.v1" },
    ]);
  });

  it("leaves a claim for lease recovery if commit state cannot be read", async () => {
    const f = fixture();
    f.storage.run.mockRejectedValue(new Error("connection lost"));
    f.storage.get.mockRejectedValue(new Error("database unavailable"));
    await f.worker.tick();
    expect(f.storage.fail).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      {
        type: "error",
        consumer: "projection.v1",
        code: "RECONCILIATION_FAILED",
      },
    ]);
  });

  it("releases capacity when reconciliation reads stall and never starts a late failure write", async () => {
    const f = fixture(undefined, {
      concurrency: 1,
      transactionMaxWaitMs: 50,
      transactionTimeoutMs: 500,
    });
    const read = deferred<InboxRecord | null>();
    f.handle.mockRejectedValueOnce(new Error("handler failure"));
    f.storage.get.mockReturnValue(read.promise);
    const first = f.worker.tick();
    await flush();
    expect(f.storage.get).toHaveBeenCalledTimes(1);
    expect(await f.worker.tick()).toBe(0);
    await vi.advanceTimersByTimeAsync(550);
    expect(await first).toBe(1);
    expect(f.events).toContainEqual({
      type: "error",
      consumer: "projection.v1",
      code: "RECONCILIATION_FAILED",
    });

    f.storage.claim.mockResolvedValueOnce([
      record({ id: "00000000-0000-4000-8000-000000000002" }),
    ]);
    expect(await f.worker.tick()).toBe(1);
    expect(f.handle).toHaveBeenCalledTimes(2);

    read.resolve(f.row);
    await flush();
    expect(f.storage.fail).not.toHaveBeenCalled();
    await f.worker.stop();
  });

  it("does not hold a concurrency slot for a stalled failure update", async () => {
    const f = fixture(undefined, { concurrency: 1 });
    const failureWrite = deferred<boolean>();
    f.handle.mockRejectedValueOnce(new Error("handler failure"));
    f.storage.fail.mockReturnValueOnce(failureWrite.promise);
    const first = f.worker.tick();
    await flush();
    expect(f.storage.fail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(550);
    expect(await first).toBe(1);
    expect(f.events.at(-1)?.code).toBe("RECONCILIATION_FAILED");

    f.storage.claim.mockResolvedValueOnce([
      record({ id: "00000000-0000-4000-8000-000000000002" }),
    ]);
    expect(await f.worker.tick()).toBe(1);
    failureWrite.reject(new Error("late driver rejection"));
    await flush();
    expect(f.events.filter((event) => event.type === "retry")).toHaveLength(0);
    await f.worker.stop();
  });

  it("never records failure using a replaced claim token or a requeued state", async () => {
    for (const current of [
      record({ claimToken: "2" }),
      record({ status: "PENDING" }),
    ]) {
      const f = fixture();
      f.handle.mockRejectedValue(new Error("failure"));
      f.storage.get.mockResolvedValue(current);
      await f.worker.tick();
      expect(f.storage.fail).not.toHaveBeenCalled();
      expect(f.events[0]?.type).toBe("lease_lost");
    }
  });

  it("does not write failure after a completion fence rejected ownership", async () => {
    const f = fixture();
    f.storage.run.mockRejectedValue(new InboxLeaseLostError());
    await f.worker.tick();
    expect(f.storage.fail).not.toHaveBeenCalled();
    expect(f.events[0]?.type).toBe("lease_lost");
  });

  it("aborts the transaction callback when heartbeat loses ownership, even if the handler ignores its signal", async () => {
    const f = fixture();
    const pending = deferred<void>();
    f.handle.mockReturnValue(pending.promise);
    f.storage.heartbeat.mockResolvedValue(false);
    const tick = f.worker.tick();
    await flush();
    const signal = f.handle.mock.calls[0]?.[1].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(100);
    await tick;
    expect(signal.aborted).toBe(true);
    expect(f.storage.fail).not.toHaveBeenCalled();
    expect(f.events[0]?.type).toBe("lease_lost");
    pending.resolve();
  });

  it("serializes slow heartbeats and bounds their lifetime for a hung handler", async () => {
    const f = fixture(undefined, {
      transactionTimeoutMs: 300,
      transactionMaxWaitMs: 50,
    });
    const pending = deferred<void>();
    const heartbeat = deferred<boolean>();
    f.handle.mockReturnValue(pending.promise);
    f.storage.heartbeat.mockReturnValue(heartbeat.promise);
    const tick = f.worker.tick();
    await flush();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.storage.heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    await tick;
    expect(f.storage.fail.mock.calls[0]?.[2].code).toBe("PROCESSING_TIMEOUT");
    heartbeat.resolve(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.storage.heartbeat).toHaveBeenCalledTimes(1);
    pending.resolve();
  });

  it("reserves capacity across overlapping claims and frees slots after a batch settles", async () => {
    const f = fixture(undefined, { concurrency: 1 });
    const claim = deferred<InboxRecord[]>();
    const pending = deferred<void>();
    f.storage.claim
      .mockReset()
      .mockReturnValueOnce(claim.promise)
      .mockResolvedValue([]);
    f.handle.mockReturnValue(pending.promise);
    const first = f.worker.tick();
    expect(await f.worker.tick()).toBe(0);
    expect(f.storage.claim).toHaveBeenCalledTimes(1);
    claim.resolve([f.row]);
    await flush();
    expect(await f.worker.tick()).toBe(0);
    pending.resolve();
    expect(await first).toBe(1);
    expect(await f.worker.tick()).toBe(0);
    expect(f.storage.claim).toHaveBeenCalledTimes(2);
  });

  it("claims a newly free slot while another record from the previous batch is still running", async () => {
    const f = fixture();
    const slow = deferred<void>();
    f.storage.claim
      .mockReset()
      .mockResolvedValueOnce([
        f.row,
        record({ id: "00000000-0000-4000-8000-000000000002" }),
      ])
      .mockResolvedValueOnce([
        record({ id: "00000000-0000-4000-8000-000000000003" }),
      ]);
    f.handle.mockImplementation((_payload, context) =>
      context.inboxId === f.row.id ? slow.promise : Promise.resolve(),
    );
    const first = f.worker.tick();
    await flush();
    expect(await f.worker.tick()).toBe(1);
    expect(f.storage.claim.mock.calls[1]?.[1]).toBe(1);
    slow.resolve();
    expect(await first).toBe(2);
  });

  it("does not execute records returned by a claim that raced shutdown", async () => {
    const f = fixture();
    const claim = deferred<InboxRecord[]>();
    f.storage.claim.mockReset().mockReturnValue(claim.promise);
    const ticking = f.worker.tick();
    await flush();
    const stopping = f.worker.stop();
    claim.resolve([f.row]);
    await Promise.all([ticking, stopping]);
    expect(f.handle).not.toHaveBeenCalled();
    expect(f.storage.heartbeat).not.toHaveBeenCalled();
    expect(await f.worker.tick()).toBe(0);
  });

  it("does not start a reserved DB claim if shutdown runs before its microtask", async () => {
    const f = fixture();
    const ticking = f.worker.tick();
    await f.worker.stop();
    expect(await ticking).toBe(0);
    expect(f.storage.claim).not.toHaveBeenCalled();
  });

  it("bounds shutdown drain and aborts hanging callbacks", async () => {
    const f = fixture();
    const pending = deferred<void>();
    f.handle.mockReturnValue(pending.promise);
    const ticking = f.worker.tick();
    await flush();
    const stopping = f.worker.stop();
    expect(f.worker.stop()).toBe(stopping);
    await vi.advanceTimersByTimeAsync(200);
    await stopping;
    await ticking;
    expect(f.handle.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(f.storage.fail).not.toHaveBeenCalled();
    pending.resolve();
  });

  it("isolates throwing, rejecting, and hanging observers from committed processing", async () => {
    for (const observer of [
      () => {
        throw new Error("observer failure");
      },
      () => Promise.reject(new Error("observer failure")),
      () => new Promise<void>(() => undefined),
    ]) {
      const f = fixture();
      const worker = new InboxWorker(
        f.storage as unknown as PrismaInboxStorage,
        [f.handler],
        options(),
        observer,
      );
      expect(await worker.tick()).toBe(1);
      expect(f.storage.fail).not.toHaveBeenCalled();
      await worker.stop();
    }
  });

  it("polls only when enabled and does not restart after stop", async () => {
    const f = fixture();
    f.worker.start();
    f.worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.storage.claim).toHaveBeenCalledTimes(1);
    await f.worker.stop();
    f.worker.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.storage.claim).toHaveBeenCalledTimes(1);

    const disabled = fixture(undefined, { enabled: false });
    disabled.worker.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(disabled.storage.claim).not.toHaveBeenCalled();
  });

  it("rejects ambiguous registrations or a missing owned handler before polling", () => {
    const f = fixture();
    expect(
      () =>
        new InboxWorker(
          f.storage as unknown as PrismaInboxStorage,
          [f.handler, f.handler],
          options(),
        ),
    ).toThrow(InboxConfigurationError);
    expect(
      () =>
        new InboxWorker(
          f.storage as unknown as PrismaInboxStorage,
          [],
          options(),
        ),
    ).toThrow(InboxConfigurationError);
  });
});
