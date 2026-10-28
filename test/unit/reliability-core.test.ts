import { describe, expect, it, vi } from "vitest";
import {
  CanonicalJsonError,
  canonicalJson,
  retryDelayMs,
  sha256Json,
  withAbort,
} from "../../src/internal/reliability-core";
import { InboxValidationError } from "../../src/contracts/errors";
import { normalizeEnvelope } from "../../src/internal/validation";

describe("private reliability primitives", () => {
  it("preserves the persisted inbox fingerprint v1 after extraction", () => {
    const result = normalizeEnvelope(
      {
        scope: { kind: "global" },
        source: "source",
        consumer: "consumer",
        messageId: "event-1",
        eventType: "created",
        schemaVersion: 1,
        payload: { b: [-0, { y: 2, x: 1 }], a: true },
      },
      ["consumer"],
    );
    expect(result.fingerprintVersion).toBe(1);
    expect(result.fingerprint).toBe(
      "2875c4bc066c3886d64fe94ce7b26b8fa51ca5deff1d8e73842bba974a7f3afb",
    );
  });

  it("has explicit hash domains and stable JSON independent of insertion order", () => {
    const left = { "2": 2, "10": 10, nested: { b: [1, null], a: "💌" } };
    const right = { nested: { a: "💌", b: [1, null] }, "10": 10, "2": 2 };
    expect(canonicalJson(left)).toBe(
      '{"10":10,"2":2,"nested":{"a":"💌","b":[1,null]}}',
    );
    expect(sha256Json(left)).toBe(sha256Json(right));
    expect(sha256Json(left)).not.toBe(sha256Json(left, { domain: "event.v1" }));
    expect(sha256Json(left, { domain: "event.v1" })).not.toBe(
      sha256Json(left, { domain: "event.v2" }),
    );
    expect(() => sha256Json(left, { domain: "event\0v1" })).toThrow(
      CanonicalJsonError,
    );
  });

  it("rejects active JavaScript values and preserves Inbox's error type", () => {
    const toJSON = vi.fn(() => "hidden");
    expect(() => canonicalJson({ toJSON })).toThrow(CanonicalJsonError);
    expect(toJSON).not.toHaveBeenCalled();
    expect(() =>
      normalizeEnvelope(
        {
          scope: { kind: "global" },
          source: "source",
          consumer: "consumer",
          messageId: "event-1",
          eventType: "created",
          schemaVersion: 1,
          payload: { invalid: undefined } as never,
        },
        ["consumer"],
      ),
    ).toThrow(InboxValidationError);
    // The payload alone fits the node budget; adding fingerprint metadata does not.
    expect(() =>
      normalizeEnvelope(
        {
          scope: { kind: "global" },
          source: "source",
          consumer: "consumer",
          messageId: "event-1",
          eventType: "created",
          schemaVersion: 1,
          payload: Array(99999).fill(0),
        },
        ["consumer"],
      ),
    ).toThrow(InboxValidationError);
  });

  it("supports deterministic exponential retry without overflow", () => {
    const policy = { baseMs: 1000, maxMs: 5000 };
    expect([1, 2, 3, 4, 10000].map((n) => retryDelayMs(n, policy))).toEqual([
      1000, 2000, 4000, 5000, 5000,
    ]);
    expect(
      retryDelayMs(Number.MAX_SAFE_INTEGER, { baseMs: 1, maxMs: 2147483647 }),
    ).toBe(2147483647);
    expect(retryDelayMs(100, { baseMs: 0, maxMs: 0 })).toBe(0);
  });

  it("applies full jitter including both zero and the cap", () => {
    const policy = { baseMs: 1000, maxMs: 5000, jitter: "full" as const };
    expect(retryDelayMs(3, policy, () => 0)).toBe(0);
    expect(retryDelayMs(3, policy, () => 0.5)).toBe(2000);
    expect(retryDelayMs(3, policy, () => 1 - Number.EPSILON)).toBe(4000);
    expect(retryDelayMs(10000, policy, () => 1 - Number.EPSILON)).toBe(5000);
    expect(() => retryDelayMs(1, policy, () => 1)).toThrow(RangeError);
    expect(() => retryDelayMs(0, policy)).toThrow(RangeError);
  });

  it("does not start work when cancellation wins before callback execution", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => "unexpected");
    const operation = withAbort(controller.signal, run);
    const reason = new Error("ownership lost");
    controller.abort(reason);
    await expect(operation).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });

  it("releases cancellation listeners on successful completion", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(withAbort(controller.signal, async () => 42)).resolves.toBe(
      42,
    );
    await Promise.resolve();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("bounds hung work and observes a late rejection after cancellation", async () => {
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const operation = withAbort(
      controller.signal,
      () => new Promise<never>((_resolve, fail) => (reject = fail)),
    );
    await Promise.resolve();
    controller.abort(new Error("expired"));
    await expect(operation).rejects.toThrow("expired");
    reject(new Error("late failure"));
    await Promise.resolve();
  });
});
