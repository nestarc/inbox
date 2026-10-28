import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { TenancyContext, TenancyService } from "@nestarc/tenancy";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PrismaClient } from "../prisma/generated";
import { requireTestDatabase } from "../prisma/fixture-guard";
import { InboxService } from "../../src/inbox.service";
import { InboxPermanentError } from "../../src/contracts/errors";
import type { InboxContext, InboxEnvelope } from "../../src/contracts/types";
import { createInboxTenancyContext } from "../../src/integrations/tenancy";
import { consumer, createFixture, envelope } from "./fixture";

describe("Inbox with @nestarc/tenancy and PostgreSQL RLS", () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  let prisma: PrismaClient;
  const role = `inbox_tenancy_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const context = new TenancyContext();
  const tenancy = new TenancyService(context);
  const services = new Set<InboxService>();

  beforeAll(async () => {
    const connectionString = requireTestDatabase();
    fixture = await createFixture();
    // Only generated hex is interpolated into DDL identifiers/credentials.
    await fixture.pool.query(`
      CREATE ROLE ${role} LOGIN PASSWORD '${password}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
      CREATE TABLE public.inbox_tenancy_test_effects (
        id uuid PRIMARY KEY, tenant_id text NOT NULL,
        inbox_id uuid NOT NULL, note text NOT NULL
      );
      CREATE INDEX ON public.inbox_tenancy_test_effects (tenant_id);
      ALTER TABLE public.inbox_tenancy_test_effects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.inbox_tenancy_test_effects FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON public.inbox_tenancy_test_effects
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''))
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), ''));
      CREATE POLICY tenant_required ON public.inbox_tenancy_test_effects AS RESTRICTIVE
        USING (NULLIF(current_setting('app.current_tenant', true), '') IS NOT NULL)
        WITH CHECK (NULLIF(current_setting('app.current_tenant', true), '') IS NOT NULL);
      CREATE TABLE public.inbox_tenancy_test_shared (
        id uuid PRIMARY KEY, inbox_id uuid NOT NULL
      );
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT ON public.nestarc_inbox_schema TO ${role};
      GRANT SELECT, INSERT, UPDATE ON public.nestarc_inbox TO ${role};
      GRANT SELECT, INSERT, UPDATE ON public.inbox_tenancy_test_effects TO ${role};
      GRANT SELECT, INSERT ON public.inbox_tenancy_test_shared TO ${role};
    `);
    const appUrl = new URL(connectionString);
    appUrl.username = role;
    appUrl.password = password;
    // A one-connection pool makes the cleanup checks reuse the exact session.
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl.toString(), max: 1 }),
    });
    await prisma.$connect();
  });

  beforeEach(async () => {
    requireTestDatabase();
    await fixture.reset();
    await fixture.pool.query(
      "TRUNCATE public.inbox_tenancy_test_effects, public.inbox_tenancy_test_shared",
    );
    for (const tenant of ["tenant-a", "tenant-b"]) {
      await fixture.pool.query(
        "INSERT INTO public.inbox_tenancy_test_effects VALUES ($1, $2, $3, 'seed')",
        [randomUUID(), tenant, randomUUID()],
      );
    }
  });

  afterEach(async () => {
    for (const service of services) await service.close();
    services.clear();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (fixture) {
      requireTestDatabase();
      await fixture.pool.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
      await fixture.close();
    }
  });

  function inbox(
    handle: (ctx: InboxContext) => Promise<void>,
    global?: "shared",
  ) {
    const service = new InboxService({
      prisma,
      handlerContext: createInboxTenancyContext({ context, tenancy, global }),
      handlers: [
        {
          consumer,
          eventType: "order.created",
          schemaVersion: 1,
          handle: async (_payload, ctx) => handle(ctx),
        },
      ],
      worker: {
        enabled: false,
        maxAttempts: 1,
        concurrency: 2,
        transactionTimeoutMs: 5_000,
      },
    });
    services.add(service);
    return service;
  }

  function incoming(overrides: Partial<InboxEnvelope> = {}): InboxEnvelope {
    const {
      payloadJson: _json,
      fingerprint: _fingerprint,
      fingerprintVersion: _version,
      ...message
    } = envelope(overrides);
    return message;
  }

  async function write(ctx: InboxContext, tenantId: string) {
    await ctx.tx.$executeRawUnsafe(
      "INSERT INTO public.inbox_tenancy_test_effects VALUES ($1::uuid, $2, $3::uuid, 'handled')",
      randomUUID(),
      tenantId,
      ctx.inboxId,
    );
  }

  it("uses a non-owner, non-superuser role and isolates each tenant's reads and writes", async () => {
    const [roleState] = await prisma.$queryRawUnsafe<
      Array<{ superuser: boolean; bypass: boolean; owner: boolean }>
    >(
      `SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass,
        c.relowner = r.oid AS owner FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.oid = 'public.inbox_tenancy_test_effects'::regclass`,
    );
    expect(roleState).toEqual({
      superuser: false,
      bypass: false,
      owner: false,
    });
    const service = inbox(async (ctx) => {
      expect(ctx.scope.kind).toBe("tenant");
      if (ctx.scope.kind !== "tenant") throw new Error("Expected tenant");
      const tenantId = ctx.scope.id;
      expect(tenancy.getCurrentTenantOrThrow()).toBe(tenantId);
      const rows = await ctx.tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
        "SELECT tenant_id FROM public.inbox_tenancy_test_effects",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.tenant_id === tenantId)).toBe(true);
      await write(ctx, tenantId);
    });
    const receipts = await Promise.all(
      ["tenant-a", "tenant-b"].map((id) =>
        service.accept(incoming({ scope: { kind: "tenant", id } })),
      ),
    );
    await service.runOnce();
    for (const receipt of receipts) {
      expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
      const count = await fixture.pool.query(
        "SELECT count(*) FROM public.inbox_tenancy_test_effects WHERE inbox_id=$1",
        [receipt.id],
      );
      expect(Number(count.rows[0].count)).toBe(1);
    }
    expect(tenancy.getCurrentTenant()).toBeNull();
  });

  it("rejects cross-tenant writes and rolls back earlier business changes with completion", async () => {
    const service = inbox(async (ctx) => {
      await write(ctx, "tenant-a");
      await write(ctx, "tenant-b");
    });
    const receipt = await service.accept(incoming());
    await service.runOnce();
    expect((await fixture.storage.get(receipt.id))?.status).toBe("DEAD");
    const rows = await fixture.pool.query(
      "SELECT * FROM public.inbox_tenancy_test_effects WHERE inbox_id=$1",
      [receipt.id],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("clears transaction settings on the pooled connection after commit and rollback", async () => {
    for (const fail of [false, true]) {
      const service = inbox(async (ctx) => {
        await write(ctx, "tenant-a");
        if (fail) throw new InboxPermanentError();
      });
      const receipt = await service.accept(incoming());
      await service.runOnce();
      expect((await fixture.storage.get(receipt.id))?.status).toBe(
        fail ? "DEAD" : "COMPLETED",
      );
      const [setting] = await prisma.$queryRawUnsafe<
        Array<{ tenant: string | null }>
      >(
        "SELECT NULLIF(current_setting('app.current_tenant', true), '') AS tenant",
      );
      expect(setting.tenant).toBeNull();
      expect(
        await prisma.$queryRawUnsafe(
          "SELECT * FROM public.inbox_tenancy_test_effects",
        ),
      ).toEqual([]);
      expect(tenancy.getCurrentTenant()).toBeNull();
      await service.close();
    }
  });

  it("rejects global messages by default without executing the handler", async () => {
    let called = false;
    const service = inbox(async () => {
      called = true;
    });
    const receipt = await service.accept(
      incoming({ scope: { kind: "global" } }),
    );
    await service.runOnce();
    expect(called).toBe(false);
    expect((await fixture.storage.get(receipt.id))?.status).toBe("DEAD");
  });

  it("allows an explicit global shared-table path without exposing tenant rows", async () => {
    const service = inbox(async (ctx) => {
      expect(tenancy.getCurrentTenant()).toBeNull();
      expect(
        await ctx.tx.$queryRawUnsafe(
          "SELECT * FROM public.inbox_tenancy_test_effects",
        ),
      ).toEqual([]);
      await ctx.tx.$executeRawUnsafe(
        "INSERT INTO public.inbox_tenancy_test_shared VALUES ($1::uuid, $2::uuid)",
        randomUUID(),
        ctx.inboxId,
      );
    }, "shared");
    const receipt = await service.accept(
      incoming({ scope: { kind: "global" } }),
    );
    await context.run("ambient-tenant", () => service.runOnce());
    expect((await fixture.storage.get(receipt.id))?.status).toBe("COMPLETED");
    const rows = await fixture.pool.query(
      "SELECT * FROM public.inbox_tenancy_test_shared WHERE inbox_id=$1",
      [receipt.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(tenancy.getCurrentTenant()).toBeNull();
  });

  it("does not let explicit global processing bypass tenant RLS writes", async () => {
    const service = inbox((ctx) => write(ctx, "tenant-a"), "shared");
    const receipt = await service.accept(
      incoming({ scope: { kind: "global" } }),
    );
    await service.runOnce();
    expect((await fixture.storage.get(receipt.id))?.status).toBe("DEAD");
    const rows = await fixture.pool.query(
      "SELECT * FROM public.inbox_tenancy_test_effects WHERE inbox_id=$1",
      [receipt.id],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
