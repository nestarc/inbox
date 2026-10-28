# Testing application handlers

`@nestarc/inbox/testing` provides bounded helpers for integration tests using a real `InboxService` and the application's PostgreSQL test database. It has no additional runtime dependencies and works with any test runner. Apply the Inbox SQL schema through your test fixture before creating the service.

## Process specific receipts

Disable automatic polling to control when processing starts. Register your application's real handler and pass the admin view for its trusted tenant scope:

```ts
import { InboxService } from "@nestarc/inbox";
import { drainInbox } from "@nestarc/inbox/testing";

const inbox = new InboxService({
  prisma,
  handlers: [orderProjectionHandler],
  worker: {
    enabled: false,
    retryBaseMs: 10,
    retryMaxMs: 20,
  },
});

try {
  const receipt = await inbox.accept({
    scope: { kind: "tenant", id: "tenant-a" },
    source: "orders",
    consumer: orderProjectionHandler.consumer,
    messageId: "order-event-1",
    eventType: orderProjectionHandler.eventType,
    schemaVersion: orderProjectionHandler.schemaVersion,
    payload: { orderId: "order-1" },
  });

  const [completed] = await drainInbox(
    inbox,
    inbox.admin.forTenant("tenant-a"),
    [receipt.id],
    { timeoutMs: 5_000 },
  );

  // completed.status is COMPLETED. Assert your actual business-table result too.
  // A repeat delivery should return the same receipt and leave that result unchanged.
} finally {
  await inbox.close();
  // Disconnect the application's Prisma client after the worker has stopped.
}
```

`drainInbox(inbox, admin, receiptIds, options)` checks each requested receipt and calls the real `runOnce()` between state checks until every receipt is `COMPLETED`. A zero-claim poll does not finish the helper: the message may be waiting for a retry or lease expiry. Retries use the worker's real schedule and do not advance a fake database clock. Configure short retry delays explicitly in tests when appropriate.

Receipt IDs select the completion assertions, **not the worker's claims**. `runOnce()` may process other receipts for its registered consumers, including other tenants. The scoped admin view restricts reads; it does not change worker ownership. Use an isolated database or dedicated test consumers, and avoid other workers when testing deterministic ordering. Receipt IDs are deduplicated, results preserve their first occurrence order, and an empty list returns immediately. A call accepts at most 1,000 IDs.

## Observe an existing worker

`waitForInboxRecord()` only reads a receipt; it never starts processing, requeues a failure or changes the database. Use it with automatic polling or a separately managed worker:

```ts
import { waitForInboxRecord } from "@nestarc/inbox/testing";

const completed = await waitForInboxRecord(admin, receipt.id);

// For a test deliberately exhausting retries:
const dead = await waitForInboxRecord(admin, failedReceipt.id, {
  status: "DEAD",
  timeoutMs: 10_000,
});
```

The expected status is `COMPLETED` by default, or `DEAD` when specified. Observing the other terminal state fails immediately. A missing or out-of-scope record remains pending until the timeout or pass limit; this helper cannot distinguish those two cases.

## Limits and failures

Both helpers accept these options:

| Option           | Default | Meaning                                                                     |
| ---------------- | ------- | --------------------------------------------------------------------------- |
| `timeoutMs`      | `5000`  | Overall budget including database reads and worker calls                    |
| `pollIntervalMs` | `10`    | Delay between state-check passes                                            |
| `maxPasses`      | `1000`  | Maximum state-check passes; no new worker call starts after the final check |
| `signal`         | None    | An `AbortSignal` that stops waiting and starting new polls                  |

Numeric options must be positive 32-bit integers. A stalled `get()` or `runOnce()` is also covered by the overall timeout. Timeout or cancellation stops the helper's wait; an already running database operation or handler may still finish. Always close the service before disconnecting Prisma or tearing down the fixture. These helpers do not create or reset databases and do not replace the runtime's transaction timeouts.

`InboxTestError` exposes `code` and a `records` snapshot containing only receipt IDs, last observed states and attempt counts. Codes are `TIMEOUT`, `ABORTED`, `PASS_LIMIT`, `UNEXPECTED_TERMINAL_STATE` and `INVALID_OPTIONS`. The helper's diagnostics omit payloads, tenant values and raw handler errors. Underlying database errors propagate unchanged so a broken database cannot be mistaken for an unfinished receipt.

Use real timers for PostgreSQL integration tests: advancing a test runner's fake timers does not advance PostgreSQL retry or lease timestamps. A successful wait proves that the requested receipts reached the expected state; assert application rows and outbox results separately to verify business effects.
