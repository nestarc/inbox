import { describe, expect, it } from "vitest";
import type { InboxEnvelope } from "../../src/contracts/types";
import {
  canonicalJson,
  normalizeEnvelope,
  validateScope,
} from "../../src/internal/validation";

const envelope = (payload: unknown): InboxEnvelope => ({
  scope: { kind: "tenant", id: "tenant-a" },
  source: "source",
  consumer: "consumer",
  messageId: "event-1",
  eventType: "created",
  schemaVersion: 1,
  payload: payload as never,
});
describe("fingerprint and envelope contract", () => {
  it("is stable across key order, trace metadata, and JSON negative zero", () => {
    const first = normalizeEnvelope(
      envelope({ b: [0, { y: 2, x: 1 }], a: true }),
      ["consumer"],
    );
    const second = normalizeEnvelope(
      {
        ...envelope({ a: true, b: [-0, { x: 1, y: 2 }] }),
        correlationId: "different",
        headers: { traceparent: "trace" },
      },
      ["consumer"],
    );
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprintVersion).toBe(1);
    expect(first.payloadJson).toBe('{"a":true,"b":[0,{"x":1,"y":2}]}');
  });
  it("separates array order, JSON types, event type and schema version", () => {
    const values = [
      envelope([1, 2]),
      envelope([2, 1]),
      envelope(["1", 2]),
      { ...envelope([1, 2]), schemaVersion: 2 },
      { ...envelope([1, 2]), eventType: "updated" },
    ];
    expect(
      new Set(values.map((v) => normalizeEnvelope(v, ["consumer"]).fingerprint))
        .size,
    ).toBe(5);
  });
  it("snapshots payload instead of retaining caller-owned mutable objects", () => {
    const payload = { nested: { value: 1 } };
    const normalized = normalizeEnvelope(envelope(payload), ["consumer"]);
    payload.nested.value = 2;
    expect(normalized.payload).toEqual({ nested: { value: 1 } });
  });
  it.each([
    undefined,
    Infinity,
    NaN,
    1n,
    new Date(),
    new Map(),
    () => null,
    "\u0000",
    "\ud800",
    "\udc00",
    { x: undefined },
    [undefined],
    Array(2),
  ])("rejects non JSON or PostgreSQL-incompatible value %#", (value) => {
    expect(() => normalizeEnvelope(envelope(value), ["consumer"])).toThrow();
  });
  it("does not invoke accessors while canonicalizing", () => {
    let called = false;
    const payload = Object.defineProperty({}, "key", {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });
    expect(() => canonicalJson(payload)).toThrow();
    expect(called).toBe(false);
  });
  it("rejects cycles, excessive nesting and oversized multibyte payloads", () => {
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow();
    let nested: any = null;
    for (let i = 0; i < 66; i++) nested = [nested];
    expect(() => canonicalJson(nested)).toThrow();
    expect(() => canonicalJson("가가", 7)).toThrow();
    expect(canonicalJson("가", 5)).toBe('"가"');
  });
  it("supports JSON null, supplementary unicode, and literal __proto__ keys", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("💌")).toBe('"💌"');
    expect(canonicalJson(JSON.parse('{"__proto__":{"safe":true}}'))).toBe(
      '{"__proto__":{"safe":true}}',
    );
  });
  it("stops serialization at the byte budget before walking the remaining payload", () => {
    const hugeRepeated = Array(99999).fill("x".repeat(10000));
    expect(() => canonicalJson(hugeRepeated, 20000)).toThrow("maxPayloadBytes");
    expect(() =>
      canonicalJson(
        {
          first: "x".repeat(32),
          later: {
            get trap() {
              throw new Error("must not visit");
            },
          },
        },
        32,
      ),
    ).toThrow("maxPayloadBytes");
    expect(() => canonicalJson(["\n".repeat(10)], 20)).toThrow(
      "maxPayloadBytes",
    );
  });
  it("requires explicit scope and a configured consumer", () => {
    expect(validateScope({ kind: "global" })).toEqual({ kind: "global" });
    expect(() => validateScope({ kind: "global", id: "tenant-a" })).toThrow();
    expect(() => validateScope({ kind: "tenant", id: "" })).toThrow();
    expect(() => normalizeEnvelope(envelope({}), ["other"])).toThrow();
    expect(() =>
      normalizeEnvelope({ ...envelope({}), messageId: "한".repeat(100) }, [
        "consumer",
      ]),
    ).toThrow();
  });
  it("rejects secret/unrecognized metadata instead of persisting it", () => {
    expect(() =>
      normalizeEnvelope(
        { ...envelope({}), headers: { authorization: "secret" } as never },
        ["consumer"],
      ),
    ).toThrow();
    expect(() =>
      normalizeEnvelope(
        { ...envelope({}), secret: "hidden" } as InboxEnvelope,
        ["consumer"],
      ),
    ).toThrow();
  });
});
