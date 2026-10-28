# @nestarc/inbox usage

This document describes the 0.1 Preview API. Inbox durably receives messages and processes them with Prisma and PostgreSQL. The application owns authentication, broker acknowledgments, its Prisma client, and migration deployment.

## Initialize the schema and Prisma client

Apply the SQL exported as `@nestarc/inbox/sql/create-inbox-table.sql` through your application's migration process before starting Inbox. Runtime initialization checks the schema; it does not create or upgrade tables. Keep the inbox SQL tables in your migration history and do not let Prisma schema synchronization remove unmanaged tables.

Preview.1 requires schema version 2. Stop workers using schema v1, apply the exported `@nestarc/inbox/sql/migrate-v1-to-v2.sql`, then start Preview.1 workers. The transactional migration preserves receipt identity, payloads, state, attempts, and tokens and may be applied again safely. It takes a table lock, so schedule the upgrade appropriately. Fresh installs use the current creation SQL. Old workers must not be restarted against v2.

Prisma 7 requires a driver adapter. Construct one application-owned client and pass it to Inbox:

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
```

Use the API for your installed Prisma major. The [runnable examples](../examples/README.md) pin Prisma 7 and install Inbox from its packed tarball.

## Register a consumer

Register stable logical consumer names and explicitly enable the worker:

```ts
import { Module } from "@nestjs/common";
import { InboxModule, InboxPermanentError } from "@nestarc/inbox";
import type { Prisma } from "./generated/prisma/client";
import type { InboxHandler } from "@nestarc/inbox";

const handler: InboxHandler<{ orderId: string }, Prisma.TransactionClient> = {
  consumer: "orders.projection.v1",
  eventType: "order.created",
  schemaVersion: 1,
  validate(payload) {
    return (
      !!payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof payload.orderId === "string"
    );
  },
  async handle(payload, context) {
    if (context.scope.kind !== "tenant") throw new InboxPermanentError();
    await context.tx.orderProjection.create({
      data: { tenantId: context.scope.id, orderId: payload.orderId },
    });
  },
};

@Module({
  imports: [
    InboxModule.forRoot({
      prisma,
      handlers: [handler],
      worker: { enabled: true },
    }),
  ],
})
export class AppModule {}
```

The application defines its Prisma models and supplies `prisma` above. For dependency injection, use `InboxModule.forRootAsync({ imports, inject, useFactory })`; the factory returns the same options. Create handlers inside the factory when they depend on other Nest services.

Worker processing is disabled unless `worker.enabled` is true. An ingress-only process supplies `consumers: ['orders.projection.v1']` and no handlers. A worker process registers handlers and may restrict processing through `worker.consumers`. Claiming, lease recovery, and exhausted-attempt handling stay inside that list. A missing handler for a configured worker consumer or a duplicate handler registration fails startup.

Removing every worker for a consumer leaves its backlog pending. Monitor backlog age before removing a deployment. Unsupported event types or schema versions for a registered consumer are retained as DEAD; they are never silently acknowledged as completed business work.

## Worker configuration

| Option                        | Default                  | Meaning                                                                 |
| ----------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| `worker.enabled`              | `false`                  | Start polling during application initialization                         |
| `worker.consumers`            | Registered handler names | The worker's explicit ownership list                                    |
| `worker.concurrency`          | `4`                      | Maximum claimed, active records; upper bound 100                        |
| `worker.pollIntervalMs`       | `1000`                   | Delay between polling opportunities                                     |
| `worker.leaseMs`              | `30000`                  | Database lease duration                                                 |
| `worker.heartbeatIntervalMs`  | `5000`                   | Renewal interval; must be less than half the lease duration             |
| `worker.transactionTimeoutMs` | `10000`                  | Maximum handler transaction duration                                    |
| `worker.transactionMaxWaitMs` | `5000`                   | Maximum wait to acquire a Prisma transaction connection                 |
| `worker.lockTimeoutMs`        | `1000`                   | Database lock-wait bound for the handler transaction                    |
| `worker.shutdownTimeoutMs`    | `15000`                  | Bounded drain interval on shutdown                                      |
| `worker.maxAttempts`          | `8`                      | Total claims per retry cycle, including the initial attempt and crashes |
| `worker.retryBaseMs`          | `1000`                   | Base for exponential retry delay                                        |
| `worker.retryMaxMs`           | `300000`                 | Maximum retry delay before jitter                                       |
| `maxPayloadBytes`             | `262144`                 | Accepted JSON payload size in UTF-8 bytes                               |
| `maxPendingMessages`          | Unset                    | Optional approximate backlog admission bound                            |

Keep enough pool connections available for admission, heartbeat, and state changes in addition to handler transactions. Larger concurrency does not automatically improve throughput. Leave external network work out of the transaction and tune limits with measurements from your own database.

For explicit execution without a continuously polling process, `InboxService.initialize()` checks the schema, `runOnce()` processes a bounded batch, and `close()` stops the worker. A Nest module invokes initialization and shutdown automatically. `close()` does not disconnect the application's Prisma client.

## Accept a message and acknowledge it

```ts
const receipt = await inbox.accept({
  scope: { kind: "tenant", id: verifiedTenantId },
  source: "orders-service",
  consumer: "orders.projection.v1",
  messageId: event.id,
  eventType: "order.created",
  schemaVersion: 1,
  payload: { orderId: event.orderId },
});
channel.ack(message);
```

`accept()` resolves only after its own transaction commits. It returns `{ kind: 'accepted' | 'duplicate', id, status }`. Both kinds permit transport acknowledgment. A duplicate can refer to a PENDING, PROCESSING, RETRYABLE, COMPLETED, or DEAD record; it never resets processing state or retry budgets. DEAD records require operator intervention.

A storage exception or uncertain acceptance commit result must not produce a success ACK. Let the transport redeliver the same stable identity. Authentication failures, invalid input, and identity conflicts require an explicit rejection or transport dead-letter policy rather than a hot retry loop.

Inbox does not acknowledge messages, return HTTP responses, or connect to brokers itself. [Runnable RabbitMQ and webhook examples](../examples/README.md) show those application boundaries.

## Identity and payload

The unique identity combines scope, source, consumer, and message ID. Scope is either `{ kind: 'tenant', id }` or `{ kind: 'global' }`. Tenant IDs are application-authenticated values; scope selection alone does not implement PostgreSQL RLS.

Use a producer's stable event ID. Do not use a delivery tag, attempt count, or a new random ID for every redelivery. Renaming a consumer creates a different logical effect and permits processing again.

Fingerprinting covers event type, schema version, and canonical JSON payload. Object key order does not change identity content; array order does. Trace headers, correlation ID, and causation ID are metadata and do not participate. Keep values that affect business decisions inside the payload.

The same identity with different fingerprint throws `InboxConflictError` with code `IDENTITY_CONFLICT` and leaves the existing record unchanged. JSON must contain only supported JSON values. Non-finite numbers, undefined, arbitrary class instances, circular values, excessive depth, and values exceeding configured limits are rejected. No value is silently truncated to fit.

## Handler transaction and retries

Use only `context.tx` for handler writes. Inbox adds the fenced completion write and commits the whole transaction. Let transaction errors escape. Calling another Prisma client, nesting a separate transaction, or making an external API call breaks this atomic boundary.

An outbox event can join the same transaction:

```ts
await outbox.emit(context.tx, new OrderProjectedEvent(payload.orderId), {
  tenantId: context.scope.kind === "tenant" ? context.scope.id : undefined,
  ...(context.scope.kind === "global"
    ? { tenantScope: "global" as const }
    : {}),
  causationId: context.messageId,
});
```

Handler invocations can repeat. Successfully committed same-database effects are deduplicated while the completion receipt remains. Different event IDs for the same business action still require an application unique constraint. Ordering is not guaranteed.

Claims consume an attempt before handler execution, so crashes consume retry budget too. A normal error schedules a durable retry using capped exponential backoff and full jitter. `InboxPermanentError`, invalid handler payloads, unsupported schemas, and exhausted attempts lead to DEAD. Error details are redacted before persistence and observation.

Heartbeats extend only an owned, unexpired lease. Stale completion rolls back handler writes. `context.signal` is an advisory cancellation signal; handlers should stop cooperative work when it aborts. Database and callback timeouts bound the transaction even when a handler ignores that signal. No cancellation mechanism can undo an external API call.

When a completion commit response is lost, Inbox reads the current record before deciding on a failure transition. If that read is unavailable, it leaves recovery to the durable lease rather than overwriting a potentially completed record.

## Configuration

The default settings favor short database work. All durations are milliseconds.

| Option                                                 | Default                             |
| ------------------------------------------------------ | ----------------------------------- |
| `worker.enabled`                                       | `false`                             |
| `worker.concurrency` / `pollIntervalMs`                | `4` / `1000`                        |
| `worker.leaseMs` / `heartbeatIntervalMs`               | `30000` / `5000`                    |
| `worker.transactionTimeoutMs` / `transactionMaxWaitMs` | `10000` / `5000`                    |
| `worker.lockTimeoutMs` / `shutdownTimeoutMs`           | `1000` / `15000`                    |
| `worker.maxAttempts`                                   | `8`, including the initial attempt  |
| `worker.retryBaseMs` / `retryMaxMs`                    | `1000` / `300000`, with full jitter |
| `maxPayloadBytes`                                      | `262144` (256 KiB)                  |
| `maxPendingMessages`                                   | No configured admission limit       |

Handler deadlines bound heartbeats. Failure reconciliation has a separate deadline of at most five seconds so an unavailable status query cannot hold a worker slot forever. Configure the application's Prisma driver pool with enough connections for business transactions and control queries; Inbox does not create a second pool.

## Administration

Bind the tenant scope before reading or changing records:

```ts
const tenant = admin.forTenant(authenticatedTenantId);
const page = await tenant.list({ status: "DEAD", limit: 50 });
const item = await tenant.get(recordId);
if (item?.status === "DEAD") {
  await tenant.requeue({
    id: item.id,
    expectedVersion: item.rowVersion,
    reason: "Handler corrected and deployed",
    actor: operatorId,
  });
}
const stats = await tenant.stats();
```

The application authorizes the operator and derives the tenant scope. `forGlobal()` manages intentionally global records, not all tenants. `InboxPrivilegedAdminService` is an explicitly enabled, cross-tenant operator surface; configure `privilegedAdmin: true` only in an authorized control-plane application and never expose it directly as a tenant-facing controller. For `forRootAsync`, that opt-in belongs at the top level beside `imports`, `inject`, and `useFactory`, not in the returned factory options.

Requeue only accepts DEAD with the observed version. Concurrent or repeated stale operations fail with `InboxStateConflictError`. It keeps the original payload, identity, claim token, lifetime attempts, and requeue history counters, and resets the current retry-cycle budget. COMPLETED receipts cannot be reset through requeue; use the separate explicit replay API below.

### Explicit replay of a completed message

Replay deliberately permits another logical processing operation. It creates a new PENDING receipt and leaves the original completion and deduplication identity unchanged. Choose a handler whose business semantics allow reprocessing, for example a projection rebuild consumer. Business uniqueness and external side effects still need their own contracts.

```ts
const original = await admin.forTenant(authenticatedTenantId).get(originalId);
if (original?.status === "COMPLETED") {
  const replay = await admin.forTenant(authenticatedTenantId).replay({
    id: original.id,
    expectedVersion: original.rowVersion,
    requestId: persistedOperatorRequestUuid,
    targetConsumer: "orders.projection.rebuild.v1",
    actor: operatorId,
    reason: "Rebuild the projection after deploying the corrected handler",
  });
  // replay.kind is accepted or duplicate; replay.record is the new receipt.
}
```

Generate and persist one UUID per intended operator request, then reuse it unchanged after timeouts. The UUID is unique within the original tenant/global scope. Reusing it with different arguments throws `InboxReplayConflictError`. Retrying the same request returns its existing receipt even after payload cleanup. A new request needs a retained COMPLETED payload and the observed version; otherwise it fails. Payload mutation is not supported. The destination consumer must have a deployed matching handler; replay does not create one. `record.replay` and `context.replay` expose original inbox ID, source version, request ID, actor, reason, and request time. Payload cleanup preserves this lineage.

### Tenant context in the handler transaction

Install the optional `@nestarc/tenancy` peer and inject its context and service:

```ts
InboxModule.forRootAsync({
  imports: [TenancyModule],
  inject: [PrismaService, TenancyService],
  useFactory: (prisma, tenancy) => ({
    prisma,
    handlers,
    handlerContext: createInboxTenancyContext({
      context: new TenancyContext(),
      tenancy,
    }),
    worker: { enabled: true },
  }),
});
```

Use the application's raw Prisma client, not the tenancy extension that opens transactions of its own. The adapter binds async tenant context and sets the service's canonical PostgreSQL tenant setting with transaction-local `set_config` before invoking the handler on the same `context.tx`. The setting clears on commit or rollback. The application authenticates the scope, installs policies using that setting, and runs with a non-owner, non-superuser, non-BYPASSRLS database role. Inbox control tables are worker-owned; tenant isolation policies apply to application data. Scope selection alone does not authorize access.

`TenancyModule` 0.16.2 exports `TenancyService`, not the `TenancyContext` provider. Its public `new TenancyContext()` shares the package's async-local storage with the injected service. Import the configured tenancy module and the application's Prisma provider module into the factory module; the runnable example shows the full wiring.

Global messages default to a permanent rejection. `global: "shared"` explicitly permits shared-table work with an empty tenant setting; it does not bypass RLS or expose tenant rows. Generic `handlerContext(context, next)` wrappers must invoke and await `next()` exactly once; skipping it, invoking it twice, or swallowing a handler failure cannot produce a successful completion. Canceled work cannot start the handler after delayed context setup.

The tested tenancy version is 0.16.2, whose Node engine range is stricter than Inbox's: use Node 22.23.4+ on the 22 branch or 24.22.1+ on the 24 branch for that optional integration.

List results contain `records` and `nextCursor`. Pass the cursor back with the same filters to continue. Pagination order does not imply event execution order. Statistics count retained records and report the oldest pending work, so large histories have a query cost.

## Retention and observability

Completed payload cleanup is explicit:

```ts
await admin.forTenant(authenticatedTenantId).purgeCompletedPayload({
  before: new Date("2026-01-01T00:00:00Z"),
  limit: 100,
});
```

This removes eligible COMPLETED payloads while preserving identity and fingerprint. It does not delete PENDING, PROCESSING, RETRYABLE, or DEAD payloads. Retained receipts keep old redeliveries deduplicated. Manually deleting a receipt ends that guarantee; restoring an older database backup also restores an older deduplication history.

`observer(event)` receives bounded, redacted observations for accepted, duplicate, completed, retry, dead, lease-lost, and infrastructure-error outcomes. Observers are best-effort and must not be used as a durable audit trail. Avoid high-cardinality metrics labels and monitor backlog age, DEAD count, pool pressure, and processing delay. Unknown or inactive consumers can otherwise accumulate pending work without a running owner.

The optional `maxPendingMessages` admission check is approximate under concurrency; it is not a strict quota. Duplicate acceptance remains valid when that limit is reached. Database exhaustion or admission rejection must remain a failed acceptance, never a success ACK.

## Shutdown and compatibility

Enable Nest shutdown hooks for operating-system signals, and close the Nest application before disconnecting its Prisma pool. Inbox stops new claims, drains active work within its shutdown limit, and aborts timed-out work so leases can recover. The process manager's grace period should accommodate application cleanup.

Support declarations must match the executed compatibility suite. See repository validation results for tested Node, NestJS, Prisma, and PostgreSQL versions; the planning matrix is not itself evidence of support. Release migrations, actual SQL assets, and packed-consumer tests are part of that contract.
