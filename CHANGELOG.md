# Changelog

User-facing changes and upgrade actions for `@nestarc/inbox`.

## Unreleased (0.1.0-preview.1)

This is a local preview candidate; no npm release has been published. The entry includes the initial inbox implementation and additions since the local `0.1.0-preview.0` development baseline.

### Upgrade action: schema version 2

Existing schema v1 installations must migrate before running this candidate:

1. Stop processes using the schema v1 implementation.
2. Apply [`@nestarc/inbox/sql/migrate-v1-to-v2.sql`](src/sql/migrate-v1-to-v2.sql) through the application's migration process. It takes an exclusive table lock and preserves existing receipts, fingerprints, processing state, attempts, and claim tokens.
3. Deploy Preview.1 and keep schema v1 workers stopped. Runtime schema checks reject incompatible versions; Inbox does not run migrations automatically.

Fresh installations use [`@nestarc/inbox/sql/create-inbox-table.sql`](src/sql/create-inbox-table.sql). See the [schema setup and upgrade guide](docs/usage.md#initialize-the-schema-and-prisma-client).

### Initial preview foundation

- Durable `accept()` with stable message identity, canonical payload fingerprints, duplicate receipts, and explicit identity/content conflicts. Acknowledge transport delivery after acceptance commits.
- PostgreSQL workers with atomic claims, renewable leases, fenced completion, persisted retries, and DEAD records. Business writes through `context.tx`, optional outbox writes, and inbox completion commit together.
- Tenant/global administration for status, backlog statistics, version-checked DEAD requeue, and completed-payload cleanup that preserves deduplication history.

### Added since the local Preview.0 baseline

- **Completed-message replay:** The scoped admin's `replay()` method, accessed through `forTenant(id)` or `forGlobal()`, creates a separate receipt while preserving the original completion and deduplication identity. A persisted operator request UUID makes retries idempotent; records and handler context include replay lineage. New replay requests require a retained payload and the expected source version. Replay deliberately permits another business execution. [Replay contract](docs/usage.md#explicit-replay-of-a-completed-message)
- **Optional tenancy integration:** `createInboxTenancyContext()` carries `@nestarc/tenancy` context into the existing handler transaction and sets the canonical PostgreSQL tenant setting. Global messages are rejected by default; explicit shared-table processing does not bypass RLS. Applications provision their own policies and restricted roles. [Integration guide](docs/usage.md#tenant-context-in-the-handler-transaction)
- **Handler context wrappers:** `handlerContext(context, next)` supports transaction-bound setup. Completion is blocked when a wrapper skips or repeats the handler, swallows its failure, or tries to start it after cancellation.
- **More runnable integrations:** Kafka, SQS-compatible, BullMQ, tenancy, and PostgreSQL-backed HTTP idempotency examples join the outbox, RabbitMQ, and signed webhook examples. They demonstrate acceptance/ACK boundaries, duplicate delivery, retries, and invalid-message handling. [Examples and fixture coverage](examples/README.md)

### Reliability and packaging

- Extracted canonical JSON/hash, bounded retry, and cancellation helpers into a private source workspace while preserving v1 fingerprints. Other Nestarc repositories have not been migrated to this workspace.
- Added database coverage for replay races, schema v1→v2 migration, restricted-role RLS, and tenant-setting cleanup after commit and rollback. Existing crash-recovery and stale-worker tests remain part of validation.
- Packed-consumer checks cover CommonJS/ESM imports, public types, SQL exports, replay, and installation without the optional tenancy peer. Generated clients, dependency directories, and environment files are excluded from the artifact.

### Release workflow

- Added shared CI/release validation for Node 22/24 and PostgreSQL 16/18. The workflow builds one tarball, checks that same artifact in independent consumers and runnable examples, and verifies its integrity before publication.
- GitHub Release publication is configured to use npm Trusted Publishing with provenance. Preview versions target `next` and stable versions target `latest`; manual workflow runs validate and perform a publication dry run without publishing. Initial npm registration and Trusted Publisher setup are still required. [Release setup](docs/releasing.md)

### Validation status

Local unit, database, process-crash, packed-consumer, and eight-example checks passed; exact versions and remaining operational tests are recorded in [validation results](docs/validation.md). Kafka examples were exercised with Redpanda and SQS examples with ElasticMQ. These checks do not establish production AWS SQS coverage, hosted CI success, or a completed npm publication.

Added [three local Preview.1 benchmark runs](docs/benchmarks/2026-10-28-preview1-local.md) with raw JSON reports. All nine scenarios verified the expected committed effects and zero observed acceptance or worker errors. The measurements separate receipt acceptance from worker draining and record environment and sample variation; they are not a controlled speedup comparison or a production capacity estimate.

Handler calls may repeat; the atomicity guarantee applies to writes in the supplied database transaction while the receipt is retained.
