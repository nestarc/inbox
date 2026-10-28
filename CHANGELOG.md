# Changelog

User-facing changes and upgrade actions for `@nestarc/inbox`.

## 0.2.0 — 2026-10-28

Adds application integration-test helpers and reproducible operational recovery checks. Runtime processing contracts and SQL schema v2 are unchanged; upgrading from 0.1.0 requires no database migration.

### Testing helpers

- Added `@nestarc/inbox/testing` with `drainInbox()`, `waitForInboxRecord()`, and typed `InboxTestError` diagnostics. Helpers wait through persisted retry schedules and bound database reads and worker calls with a timeout, cancellation signal, and pass limit. They use the real service and scoped admin API; they do not create databases or cancel transactions already in flight. [Testing guide](docs/testing.md)
- Verified the subpath with unit tests, PostgreSQL integration tests, and a separately installed tarball consumer using strict TypeScript, CommonJS, and dynamic ESM.

### Operational validation

- Added actual TCP disconnect/blackhole, connection-pool saturation, and child-process SIGTERM recovery tests.
- Added PostgreSQL physical standby promotion after confirmed WAL replay and real SQLSTATE `53100` in a bounded disposable tablespace, including rollback and recovery assertions. [Database operations](docs/db-operations.md)
- Added RabbitMQ process restarts, unacknowledged redelivery, persisted retry/TTL delivery, and dead-letter routing tests. [Broker recovery](docs/broker-recovery.md)
- Added a disk-backed sustained benchmark with simultaneous ingress and processing, pool pressure, hot/cold tenants, retry recovery, and receipt/payload storage measurements. It verifies business effects separately from receipt completion. These bounded local measurements do not establish production capacity or an SLA.
- Added a Node 24/PostgreSQL 16 operational recovery gate to CI and release validation. Real-service adoption remains outside this release's validation scope.

### Release automation

- Wait up to 20 minutes for npm's post-publication scanning before verifying registry integrity. Pending 404 responses are retried every 30 seconds; integrity mismatches and other lookup failures still stop immediately. This prevents successful uploads from being reported as failed after only 16 seconds. No runtime API or schema changes.

## 0.1.0 — 2026-10-28

First public release version. It promotes the runtime implementation and schema verified as `0.1.0-preview.1`, with version metadata and documentation updates. Preview.0 and Preview.1 were local development baselines, not published releases. APIs and schema may change before 1.0.

### Upgrade action: schema version 2

Existing schema v1 installations from local development builds must migrate before running 0.1.0:

1. Stop processes using the schema v1 implementation.
2. Apply [`@nestarc/inbox/sql/migrate-v1-to-v2.sql`](src/sql/migrate-v1-to-v2.sql) through the application's migration process. It takes an exclusive table lock and preserves existing receipts, fingerprints, processing state, attempts, and claim tokens.
3. Deploy 0.1.0 and keep schema v1 workers stopped. Runtime schema checks reject incompatible versions; Inbox does not run migrations automatically.

Fresh installations use [`@nestarc/inbox/sql/create-inbox-table.sql`](src/sql/create-inbox-table.sql). See the [schema setup and upgrade guide](docs/usage.md#initialize-the-schema-and-prisma-client).

### Core processing

- Durable `accept()` with stable message identity, canonical payload fingerprints, duplicate receipts, and explicit identity/content conflicts. Acknowledge transport delivery after acceptance commits.
- PostgreSQL workers with atomic claims, renewable leases, fenced completion, persisted retries, and DEAD records. Business writes through `context.tx`, optional outbox writes, and inbox completion commit together.
- Tenant/global administration for status, backlog statistics, version-checked DEAD requeue, and completed-payload cleanup that preserves deduplication history.

### Replay and integrations

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
- GitHub Release publication is configured to use npm Trusted Publishing with provenance. Prereleases target `next` and release versions such as 0.1.0 target `latest`; manual workflow runs validate and perform a publication dry run without publishing. [Release setup and publishing procedure](docs/releasing.md)

### Validation status

Local unit, database, process-crash, packed-consumer, and eight-example checks passed for the Preview.1 baseline. GitHub-hosted [CI run 40684612217](https://github.com/nestarc/inbox/actions/runs/40684612217), at commit `664b4fc`, also passed all four Node 22/24 × PostgreSQL 16/18 combinations and the examples. These results cover the runtime promoted to 0.1.0; they are not evidence of a later tag's CI run or successful npm OIDC authentication. Exact versions and remaining operational tests are recorded in [validation results](docs/validation.md).

Kafka examples were exercised with Redpanda and SQS examples with ElasticMQ; production AWS SQS behavior still requires deployment-specific validation.

Included [three local Preview.1 benchmark reports](docs/benchmarks/2026-10-28-preview1-local.md) with raw JSON. All nine scenarios verified the expected committed effects and zero observed acceptance or worker errors. Their recorded package version remains `0.1.0-preview.1`; promotion to 0.1.0 changes no runtime code or schema. The measurements separate receipt acceptance from worker draining and record environment and sample variation; they are not a controlled speedup comparison or a production capacity estimate.

Handler calls may repeat; the atomicity guarantee applies to writes in the supplied database transaction while the receipt is retained.
