import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxRecord, InboxStatus } from "../../src/contracts/types";
import {
  drainInbox,
  InboxTestError,
  waitForInboxRecord,
} from "../../src/testing";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

function record(status: InboxStatus, id = first): InboxRecord {
  return {
    id,
    scope: { kind: "tenant", id: "private-tenant" },
    source: "orders",
    consumer: "projection.v1",
    messageId: "message-1",
    eventType: "order.created",
    schemaVersion: 1,
    payload: { secret: "private-payload" },
    payloadPurged: false,
    fingerprint: "fingerprint",
    fingerprintVersion: 1,
    status,
    claimToken: "1",
    rowVersion: "2",
    attemptCount: 1,
    cycleAttemptCount: 1,
    requeueCount: 0,
    receivedAt: new Date(),
    completedAt: null,
    nextAttemptAt: new Date(),
    leaseExpiresAt: null,
    workerId: null,
    lastErrorCode: "APPLICATION_ERROR",
    lastErrorMessage: "private-error",
    lastRequeueReason: null,
    lastRequeueActor: null,
    lastRequeueAt: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("public integration-test helpers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits through a zero-claim poll and scheduled retry instead of declaring the inbox drained", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(record("PENDING"))
      .mockResolvedValueOnce(record("RETRYABLE"))
      .mockResolvedValueOnce(record("RETRYABLE"))
      .mockResolvedValue(record("COMPLETED"));
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    const result = drainInbox({ runOnce }, { get }, [first]);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject([{ id: first, status: "COMPLETED" }]);
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks every requested receipt, deduplicates IDs and preserves their order", async () => {
    const get = vi.fn(async (id: string) => record("COMPLETED", id));
    const runOnce = vi.fn();
    const result = await drainInbox({ runOnce }, { get }, [
      second,
      first,
      second,
    ]);
    expect(result.map((value) => value.id)).toEqual([second, first]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("performs no reads or worker calls for an empty receipt list", async () => {
    const get = vi.fn();
    const runOnce = vi.fn();
    expect(await drainInbox({ runOnce }, { get }, [])).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("fails immediately on DEAD with diagnostics that omit payload, scope and raw errors", async () => {
    const get = vi.fn().mockResolvedValue(record("DEAD"));
    const runOnce = vi.fn();
    const error = await drainInbox({ runOnce }, { get }, [first]).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(InboxTestError);
    expect(error).toMatchObject({
      code: "UNEXPECTED_TERMINAL_STATE",
      records: [
        { id: first, status: "DEAD", attemptCount: 1, cycleAttemptCount: 1 },
      ],
    });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("can observe DEAD without running a worker", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(record("PROCESSING"))
      .mockResolvedValue(record("DEAD"));
    const result = waitForInboxRecord({ get }, first, { status: "DEAD" });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ status: "DEAD" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("rejects a completed receipt when DEAD was expected", async () => {
    await expect(
      waitForInboxRecord(
        { get: vi.fn().mockResolvedValue(record("COMPLETED")) },
        first,
        { status: "DEAD" },
      ),
    ).rejects.toMatchObject({ code: "UNEXPECTED_TERMINAL_STATE" });
  });

  it("times out missing or out-of-scope receipts and reports the last observed state", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const result = waitForInboxRecord({ get }, first, { timeoutMs: 35 }).catch(
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(35);
    expect(await result).toMatchObject({
      code: "TIMEOUT",
      records: [{ id: first, status: null, attemptCount: null }],
    });
    expect(get).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled database read and safely handles its late rejection", async () => {
    const pending = deferred<InboxRecord>();
    const get = vi.fn().mockReturnValue(pending.promise);
    const result = waitForInboxRecord({ get }, first, { timeoutMs: 20 }).catch(
      (reason: unknown) => reason,
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
    pending.reject(new Error("late database rejection"));
    await vi.advanceTimersByTimeAsync(100);
    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled processing and never starts another poll after it resolves late", async () => {
    const pending = deferred<number>();
    const get = vi.fn().mockResolvedValue(record("PENDING"));
    const runOnce = vi.fn().mockReturnValue(pending.promise);
    const result = drainInbox({ runOnce }, { get }, [first], {
      timeoutMs: 20,
    }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
    pending.resolve(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts while polling and cleans up its timers", async () => {
    const controller = new AbortController();
    const get = vi.fn().mockResolvedValue(record("PROCESSING"));
    const result = waitForInboxRecord({ get }, first, {
      signal: controller.signal,
    }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(new Error("private abort reason"));
    expect(await result).toMatchObject({ code: "ABORTED" });
    await vi.advanceTimersByTimeAsync(100);
    expect(get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not touch the database when already aborted", async () => {
    const get = vi.fn();
    await expect(
      waitForInboxRecord({ get }, first, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(get).not.toHaveBeenCalled();
  });

  it("limits state checks and avoids starting work after the final check", async () => {
    const get = vi.fn().mockResolvedValue(record("PENDING"));
    const runOnce = vi.fn().mockResolvedValue(0);
    const result = drainInbox({ runOnce }, { get }, [first], {
      maxPasses: 2,
    }).catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ code: "PASS_LIMIT" });
    expect(get).toHaveBeenCalledTimes(2);
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("propagates database failures rather than interpreting them as pending work", async () => {
    const failure = new Error("database unavailable");
    await expect(
      waitForInboxRecord({ get: vi.fn().mockRejectedValue(failure) }, first),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { pollIntervalMs: -1 },
    { maxPasses: 1.5 },
    { timeoutMs: 2147483648 },
  ])("rejects invalid timing/iteration bounds: %j", async (options) => {
    const get = vi.fn();
    await expect(
      waitForInboxRecord({ get }, first, options),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects invalid receipt IDs before reading or processing", async () => {
    const get = vi.fn();
    const runOnce = vi.fn();
    await expect(
      drainInbox({ runOnce }, { get }, ["not-a-uuid"]),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
    expect(get).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("rejects sparse receipt arrays before reading or processing", async () => {
    const get = vi.fn();
    const runOnce = vi.fn();
    await expect(
      drainInbox({ runOnce }, { get }, new Array<string>(1)),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    expect(get).not.toHaveBeenCalled();
    expect(runOnce).not.toHaveBeenCalled();
  });
});
