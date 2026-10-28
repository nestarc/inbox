import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import {
  TenancyContext,
  TenancyModule,
  TenancyService,
} from "@nestarc/tenancy";
import {
  InboxModule,
  InboxService,
  createInboxTenancyContext,
  type InboxHandler,
  type InboxScope,
} from "@nestarc/inbox";
import { PrismaClient, type Prisma } from "../generated/prisma/client";
import { exampleDatabaseUrl } from "../common";

type Payload = { targetTenant: string };
const consumer = "example.tenancy.v1";
const eventType = "example.tenant-work";

async function main() {
  // This credential is only the isolated fixture's schema administrator. Business
  // handlers use the separate role below, which cannot bypass RLS or own tables.
  const admin = new Pool({ connectionString: exampleDatabaseUrl(), max: 2 });
  const role = `inbox_example_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  let roleCreated = false;
  let prisma: PrismaClient | undefined;
  let app:
    | Awaited<ReturnType<typeof NestFactory.createApplicationContext>>
    | undefined;
  try {
    await admin.query(
      await readFile(resolve(__dirname, "../../sql/tenancy.sql"), "utf8"),
    );
    // Identifiers and credentials here consist exclusively of generated hex.
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
    roleCreated = true;
    await admin.query(`
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT ON public.nestarc_inbox_schema TO ${role};
      GRANT SELECT, INSERT, UPDATE ON public.nestarc_inbox TO ${role};
      GRANT SELECT, INSERT, UPDATE ON public.example_tenancy_records TO ${role};
      GRANT SELECT, INSERT ON public.example_tenancy_shared TO ${role};
    `);
    const appUrl = new URL(exampleDatabaseUrl());
    appUrl.username = role;
    appUrl.password = password;
    const client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl.toString(), max: 1 }),
    });
    prisma = client;
    const tenancyModule = TenancyModule.forRoot({
      tenantExtractor: "x-tenant-id",
    });

    @Module({
      imports: [
        tenancyModule,
        InboxModule.forRootAsync({
          imports: [tenancyModule],
          inject: [TenancyService],
          useFactory: (tenancy: TenancyService) => {
            // TenancyModule exports the configured service, but not the context
            // provider. Public TenancyContext instances share the package's ALS.
            const context = new TenancyContext();
            const handler: InboxHandler<Payload, Prisma.TransactionClient> = {
              consumer,
              eventType,
              schemaVersion: 1,
              async handle(payload, ctx) {
                if (ctx.scope.kind === "global") {
                  assert.equal(tenancy.getCurrentTenant(), null);
                  assert.deepEqual(
                    await ctx.tx.$queryRawUnsafe(
                      "SELECT * FROM public.example_tenancy_records",
                    ),
                    [],
                  );
                  await ctx.tx.$executeRawUnsafe(
                    "INSERT INTO public.example_tenancy_shared VALUES ($1::uuid, $2::uuid)",
                    randomUUID(),
                    ctx.inboxId,
                  );
                  return;
                }
                assert.equal(tenancy.getCurrentTenantOrThrow(), ctx.scope.id);
                const rows = await ctx.tx.$queryRawUnsafe<
                  Array<{ tenant_id: string }>
                >("SELECT tenant_id FROM public.example_tenancy_records");
                const tenantId = ctx.scope.id;
                assert.ok(rows.every((row) => row.tenant_id === tenantId));
                // Deliberately use the payload value so the forged fixture below
                // demonstrates the database's WITH CHECK policy rejecting it.
                await ctx.tx.$executeRawUnsafe(
                  "INSERT INTO public.example_tenancy_records VALUES ($1::uuid, $2, $3::uuid, 'handled')",
                  randomUUID(),
                  payload.targetTenant,
                  ctx.inboxId,
                );
              },
            };
            return {
              prisma: client,
              handlers: [handler],
              handlerContext: createInboxTenancyContext({
                context,
                tenancy,
                global: "shared",
              }),
              worker: { enabled: false, concurrency: 1, maxAttempts: 1 },
            };
          },
        }),
      ],
    })
    class AppModule {}
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: ["error", "warn"],
      abortOnError: false,
    });
    const inbox = app.get(InboxService);
    const tenancy = app.get(TenancyService);
    const runId = randomUUID();
    const tenantA = `${runId}-a`;
    const tenantB = `${runId}-b`;
    const accept = (scope: InboxScope, targetTenant: string) =>
      inbox.accept({
        scope,
        source: "trusted-fixture-route",
        consumer,
        messageId: randomUUID(),
        eventType,
        schemaVersion: 1,
        payload: { targetTenant },
      });
    // Scope comes from trusted routing. A producer payload cannot choose its scope.
    const accepted = await Promise.all([
      accept({ kind: "tenant", id: tenantA }, tenantA),
      accept({ kind: "tenant", id: tenantB }, tenantB),
      accept({ kind: "tenant", id: tenantA }, tenantB),
      accept({ kind: "global" }, ""),
    ]);
    for (let i = 0; i < accepted.length; i++) await inbox.runOnce();
    const results = await Promise.all(
      accepted.map(async (receipt) => {
        const result = await admin.query<{ status: string }>(
          "SELECT status FROM public.nestarc_inbox WHERE id=$1",
          [receipt.id],
        );
        return result.rows[0].status;
      }),
    );
    assert.deepEqual(results, ["COMPLETED", "COMPLETED", "DEAD", "COMPLETED"]);
    const rejected = await admin.query(
      "SELECT * FROM public.example_tenancy_records WHERE inbox_id=$1",
      [accepted[2].id],
    );
    assert.equal(rejected.rowCount, 0);
    assert.equal(tenancy.getCurrentTenant(), null);
    const [setting] = await client.$queryRawUnsafe<
      Array<{ tenant: string | null }>
    >(
      "SELECT NULLIF(current_setting('app.current_tenant', true), '') AS tenant",
    );
    assert.equal(setting.tenant, null);
    const [permissions] = await client.$queryRawUnsafe<
      Array<{ rolsuper: boolean; rolbypassrls: boolean }>
    >("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
    assert.equal(permissions.rolsuper, false);
    assert.equal(permissions.rolbypassrls, false);
    console.log(
      JSON.stringify({
        tenantsCompleted: 2,
        crossTenantWrite: "rejected",
        globalShared: "completed",
        contextAfterProcessing: null,
      }),
    );
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await prisma?.$disconnect();
      } finally {
        try {
          if (roleCreated)
            await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
        } finally {
          await admin.end();
        }
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
