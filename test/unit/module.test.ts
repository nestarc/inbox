import "reflect-metadata";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InboxAdminService,
  InboxModule,
  InboxPrivilegedAdminService,
  InboxService,
} from "../../src";
import type { InboxOptions, InboxPrismaClient } from "../../src";
import { PrismaInboxStorage } from "../../src/storage/prisma/prisma-inbox.storage";
import { resolveOptions } from "../../src/internal/options";

const prisma = {
  $transaction: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  $executeRawUnsafe: vi.fn(),
} as unknown as InboxPrismaClient;
const options = (): InboxOptions => ({
  prisma,
  consumers: ["events"],
  worker: { enabled: false },
});
afterEach(() => vi.restoreAllMocks());

describe("Nest integration and configuration", () => {
  it("registers scoped admin and fails closed on privileged admin by default", async () => {
    vi.spyOn(PrismaInboxStorage.prototype, "assertSchema").mockResolvedValue();
    const app = await Test.createTestingModule({
      imports: [InboxModule.forRoot(options())],
    }).compile();
    await app.init();
    expect(app.get(InboxService)).toBeInstanceOf(InboxService);
    expect(app.get(InboxAdminService)).toBeInstanceOf(InboxAdminService);
    expect(() => app.get(InboxPrivilegedAdminService)).toThrow();
    await app.close();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("supports async imports/inject and explicit privileged provider opt-in", async () => {
    vi.spyOn(PrismaInboxStorage.prototype, "assertSchema").mockResolvedValue();
    @Module({
      providers: [{ provide: "APP_DB", useValue: prisma }],
      exports: ["APP_DB"],
    })
    class DatabaseModule {}
    const app = await Test.createTestingModule({
      imports: [
        InboxModule.forRootAsync({
          imports: [DatabaseModule],
          inject: ["APP_DB"],
          privilegedAdmin: true,
          useFactory: async (db: InboxPrismaClient) => ({
            prisma: db,
            consumers: ["events"],
          }),
        }),
      ],
    }).compile();
    await app.init();
    expect(app.get(InboxPrivilegedAdminService)).toBeInstanceOf(
      InboxPrivilegedAdminService,
    );
    await app.close();
  });
  it("rejects startup on schema mismatch and never owns the Prisma connection lifecycle", async () => {
    vi.spyOn(PrismaInboxStorage.prototype, "assertSchema").mockRejectedValue(
      new Error("schema mismatch"),
    );
    const app = await Test.createTestingModule({
      imports: [InboxModule.forRoot(options())],
    }).compile();
    await expect(app.init()).rejects.toThrow("schema mismatch");
    await app.get(InboxService).close();
    // Nest propagates the rejected initialization promise from close as well.
    await expect(app.close()).rejects.toThrow("schema mismatch");
  });
  it("allows ingress-only setup but rejects missing and duplicate worker handlers", () => {
    expect(resolveOptions(options()).worker.enabled).toBe(false);
    expect(() =>
      resolveOptions({
        ...options(),
        worker: { enabled: true, consumers: ["events"] },
      }),
    ).toThrow();
    const handler = {
      consumer: "events",
      eventType: "created",
      schemaVersion: 1,
      handle: async () => {},
    };
    expect(() =>
      resolveOptions({ prisma, handlers: [handler, handler] }),
    ).toThrow();
    expect(() =>
      resolveOptions({ ...options(), worker: { heartbeatIntervalMs: 30000 } }),
    ).toThrow();
    expect(() =>
      resolveOptions({ ...options(), worker: { concurrency: 101 } }),
    ).toThrow();
    expect(() =>
      resolveOptions({ ...options(), maxPendingMessages: 2147483648 }),
    ).toThrow();
    expect(() =>
      resolveOptions({
        ...options(),
        worker: {
          transactionTimeoutMs: 2147483647,
          transactionMaxWaitMs: 1000,
        },
      }),
    ).toThrow();
  });
  it("captures the tenant scope in admin and validates requeue input", async () => {
    const storage = new PrismaInboxStorage(prisma);
    const get = vi.spyOn(storage, "get").mockResolvedValue(null);
    const admin = new InboxAdminService(storage).forTenant("trusted-tenant");
    const id = "11111111-1111-4111-8111-111111111111";
    await admin.get(id);
    expect(get).toHaveBeenCalledWith(id, {
      kind: "tenant",
      id: "trusted-tenant",
    });
    expect(() =>
      admin.requeue({
        id,
        expectedVersion: "0",
        actor: "operator",
        reason: "fixed",
      }),
    ).toThrow();
    expect(() => new InboxAdminService(storage).forTenant("")).toThrow();
  });
});
