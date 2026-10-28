# Durable inbox acceptance and transaction ownership

Status: accepted for the 0.1 Preview implementation.

Preview.1 extension: COMPLETED replay is a new receipt with a scoped idempotent request UUID and durable lineage. It never resets the original receipt. Schema v2 adds this lineage, with an explicit v1 upgrade. Optional tenancy context wraps the existing handler transaction; it cannot replace that transaction or skip handler execution.

## Decision

The package exposes durable acceptance followed by asynchronous processing. `accept()` owns its database transaction and resolves only after that transaction commits. The application may then acknowledge the broker delivery or return HTTP success. It must not interpret acceptance as completed business processing.

After acceptance, the Inbox worker owns handler retries. A redelivery from the broker checks the existing identity and returns `duplicate`; it does not create a second retry schedule. Storage failures and unknown acceptance commit results remain the ingress transport's responsibility.

Identity is the tuple `(scopeKind, scopeId, source, consumer, messageId)`. Global scope has an explicit non-null representation. Consumer names identify logical effects, not worker instances or deployment builds. A fingerprint covers event type, schema version, and canonical JSON payload; trace metadata is excluded. Conflicting content never overwrites the original record.

## Transaction boundaries

1. Acceptance inserts or observes a matching durable record and commits.
2. Claiming commits a new token, an expiring lease, and an incremented attempt count in a short transaction.
3. The handler executes in a new Prisma transaction supplied by Inbox. Its business writes, optional outbox writes, and fenced `COMPLETED` update commit together.

The completion update requires `PROCESSING`, the current token, and a valid lease. Updating zero rows throws inside the transaction, rolling back all handler writes. A successful completion update holds its row lock through commit; lease expiry between that update and commit does not permit a second completion.

Heartbeats and failure writes require the current processing token and unexpired lease. Recovery requires an expired processing lease. DEAD requeue requires the expected record version and preserves lifetime attempts and token history. Workers claim and recover only their configured consumers.

## Consequences

- Handler invocation is at least once; successfully committed effects in the same database transaction are deduplicated while the receipt is retained.
- External HTTP requests, email, other database clients, and other databases cannot join this transaction. Handlers use an outbox for subsequent delivery.
- Claim-time attempt accounting makes repeated crashes consume the retry budget. Exhaustion and permanent errors retain a DEAD record for operator action.
- Completed identity and fingerprint retention are separate from payload retention. Removing a receipt ends its deduplication guarantee.
- Business uniqueness across different message IDs and event ordering remain application concerns.
- The library does not perform schema migrations, create the Prisma connection pool, implement broker clients, or offer a second synchronous processing mode in Preview.

## Rejected alternative

A caller-owned transactional deduplication helper would be smaller but leave retry scheduling and dead-letter handling to the broker. It may be considered as a separate future API. Combining it with durable acceptance under one ambiguous `process()` method would obscure ACK timing and retry ownership.

## Verification

The [implementation roadmap](../implementation-roadmap.md) defines acceptance criteria for concurrent receipt creation, stale claims, ambiguous commits, crash recovery, tenant scope, retention, and bounded shutdown. These guarantees require real PostgreSQL tests; in-memory simulations are insufficient evidence.
