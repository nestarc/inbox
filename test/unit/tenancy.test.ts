import "reflect-metadata";
import { Test } from "@nestjs/testing";
import {
  TenancyContext,
  TenancyModule,
  TenancyService,
} from "@nestarc/tenancy";
import { describe, expect, it, vi } from "vitest";
import type { InboxContext, InboxTransaction } from "../../src/contracts/types";
import { InboxPermanentError } from "../../src/contracts/errors";
import { createInboxTenancyContext } from "../../src/integrations/tenancy";
import { InboxModule } from "../../src/inbox.module";

function fixture() {
  const context = new TenancyContext();
  const tenancy = new TenancyService(context);
  const query = vi.fn().mockResolvedValue([]);
  const tx: InboxTransaction = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
  const message: InboxContext = {
    tx,
    scope: { kind: "tenant", id: "tenant-a" },
    messageId: "message-1",
    source: "orders",
    consumer: "projection.v1",
    inboxId: "00000000-0000-4000-8000-000000000001",
    attempt: 1,
    signal: new AbortController().signal,
  };
  return { context, tenancy, query, message };
}

describe("@nestarc/tenancy handler context", () => {
  it("uses the durable tenant and exact transaction, restoring ambient context", async () => {
    const f = fixture();
    const run = createInboxTenancyContext(f);
    await f.context.run("ambient-tenant", async () => {
      await run(f.message, async () => {
        expect(f.tenancy.getCurrentTenantOrThrow()).toBe("tenant-a");
        expect(f.query).toHaveBeenCalledWith(
          "SELECT set_config($1, $2, true)",
          "app.current_tenant",
          "tenant-a",
        );
        expect(f.message.tx.$queryRawUnsafe).toBe(f.query);
      });
      expect(f.tenancy.getCurrentTenantOrThrow()).toBe("ambient-tenant");
    });
    expect(f.tenancy.getCurrentTenant()).toBeNull();
  });

  it("keeps overlapping asynchronous handlers in their own tenant context", async () => {
    const f = fixture();
    const run = createInboxTenancyContext(f);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const seen: string[] = [];
    await Promise.all(
      ["tenant-a", "tenant-b"].map((tenantId) =>
        run(
          { ...f.message, scope: { kind: "tenant", id: tenantId } },
          async () => {
            if (++arrivals === 2) release();
            await barrier;
            seen.push(f.tenancy.getCurrentTenantOrThrow());
            expect(f.tenancy.getCurrentTenantOrThrow()).toBe(tenantId);
          },
        ),
      ),
    );
    expect(seen.sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(f.tenancy.getCurrentTenant()).toBeNull();
  });

  it("rejects global scope before touching the database unless explicitly enabled", async () => {
    const f = fixture();
    const next = vi.fn();
    await expect(
      createInboxTenancyContext(f)(
        { ...f.message, scope: { kind: "global" } },
        next,
      ),
    ).rejects.toBeInstanceOf(InboxPermanentError);
    expect(next).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("clears application and transaction tenant context for explicit shared work", async () => {
    const f = fixture();
    await f.context.run("ambient-tenant", async () => {
      await createInboxTenancyContext({ ...f, global: "shared" })(
        { ...f.message, scope: { kind: "global" } },
        async () => {
          expect(f.tenancy.getCurrentTenant()).toBeNull();
          expect(f.query).toHaveBeenCalledWith(
            "SELECT set_config($1, $2, true)",
            "app.current_tenant",
            "",
          );
        },
      );
      expect(f.tenancy.getCurrentTenantOrThrow()).toBe("ambient-tenant");
    });
  });

  it("does not execute a handler after context setup fails and restores ALS", async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error("database unavailable"));
    const next = vi.fn();
    await expect(createInboxTenancyContext(f)(f.message, next)).rejects.toThrow(
      "database unavailable",
    );
    expect(next).not.toHaveBeenCalled();
    expect(f.tenancy.getCurrentTenant()).toBeNull();
  });

  it("rejects absent scope instead of inheriting an ambient tenant", async () => {
    const f = fixture();
    const next = vi.fn();
    await f.context.run("ambient-tenant", async () => {
      await expect(
        createInboxTenancyContext(f)(
          { ...f.message, scope: undefined } as unknown as InboxContext,
          next,
        ),
      ).rejects.toThrow();
    });
    expect(next).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("inherits a custom canonical setting from the actual TenancyModule", async () => {
    const tenancyModule = TenancyModule.forRoot({
      tenantExtractor: "x-tenant-id",
      dbSettingKey: "app.inbox_tenant",
    });
    let run: ReturnType<typeof createInboxTenancyContext> | undefined;
    const f = fixture();
    const app = await Test.createTestingModule({
      imports: [
        InboxModule.forRootAsync({
          imports: [tenancyModule],
          inject: [TenancyService],
          useFactory: (tenancy: TenancyService) => {
            run = createInboxTenancyContext({
              context: new TenancyContext(),
              tenancy,
            });
            return {
              prisma: {
                ...f.message.tx,
                $transaction: async <T>(
                  callback: (tx: InboxTransaction) => Promise<T>,
                ) => callback(f.message.tx),
              },
              consumers: ["projection.v1"],
              handlerContext: run,
            };
          },
        }),
      ],
    }).compile();
    try {
      expect(run).toBeDefined();
      await run!(f.message, async () => {
        expect(app.get(TenancyService).getCurrentTenantOrThrow()).toBe(
          "tenant-a",
        );
      });
      expect(f.query).toHaveBeenCalledWith(
        "SELECT set_config($1, $2, true)",
        "app.inbox_tenant",
        "tenant-a",
      );
    } finally {
      await app.close();
    }
  });
});
