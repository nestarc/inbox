import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InboxAdminService,
  type InboxReplayOptions,
} from "../../src/inbox-admin.service";
import { InboxValidationError } from "../../src/contracts/errors";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";

const request = (): InboxReplayOptions => ({
  id: randomUUID(),
  expectedVersion: "3",
  requestId: randomUUID(),
  targetConsumer: "orders.projection.rebuild.v2",
  reason: "Rebuild the projection after the handler fix",
  actor: "operator-1",
});
function setup() {
  const storage = { replay: vi.fn().mockResolvedValue({ kind: "accepted" }) };
  const admin = new InboxAdminService(
    storage as unknown as PrismaInboxStorage,
  ).forTenant("tenant-a");
  return { storage, admin };
}

describe("completed replay administration", () => {
  it("captures scope and normalizes UUIDs without exposing payload overrides", async () => {
    const { admin, storage } = setup();
    const input = request();
    await admin.replay({
      ...input,
      id: input.id.toUpperCase(),
      requestId: input.requestId.toUpperCase(),
    });
    expect(storage.replay).toHaveBeenCalledExactlyOnceWith(input, {
      kind: "tenant",
      id: "tenant-a",
    });
  });

  it.each([
    { id: "bad" },
    { requestId: "bad" },
    { expectedVersion: "0" },
    { expectedVersion: "9223372036854775808" },
    { expectedVersion: 1 },
    { targetConsumer: " " },
    { targetConsumer: "x".repeat(129) },
    { reason: "" },
    { actor: "" },
    { actor: "invalid\0actor" },
    { reason: "x".repeat(1025) },
    { payload: { changed: true } },
    { scope: { kind: "tenant", id: "another-tenant" } },
  ])(
    "rejects malformed or unsupported replay option %# before storage",
    (override) => {
      const { admin, storage } = setup();
      expect(() =>
        admin.replay({ ...request(), ...override } as InboxReplayOptions),
      ).toThrow(InboxValidationError);
      expect(storage.replay).not.toHaveBeenCalled();
    },
  );

  it("rejects missing options and accessor-backed values without running their getters", () => {
    const { admin, storage } = setup();
    expect(() => admin.replay(null as never)).toThrow(InboxValidationError);
    const getter = vi.fn(() => "operator");
    const input = Object.defineProperty(request(), "actor", {
      enumerable: true,
      get: getter,
    });
    expect(() => admin.replay(input)).toThrow(InboxValidationError);
    expect(getter).not.toHaveBeenCalled();
    expect(storage.replay).not.toHaveBeenCalled();
  });
});
