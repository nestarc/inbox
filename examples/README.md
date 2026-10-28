# Runnable inbox examples

These examples import the installed `@nestarc/inbox` package and use a real PostgreSQL database. The outbox and webhook examples run once, assert their results, and exit. The RabbitMQ example additionally requires the local broker fixture.

Use Node 22.23.4+ or 24.22.1+ for the full examples project because it includes `@nestarc/tenancy` 0.16.2. The package's full `npm run test:examples` command builds a tarball, installs these examples in an isolated directory, and executes every example against temporary fixtures.

## Install the package

Run these commands from `examples/`:

```sh
npm install --no-save @nestarc/inbox@0.2.0
npm run generate
npm run build
```

To run against a local source build instead, run `npm ci` and `npm pack` from the repository root. Then, from `examples/`, install the tarball and regenerate/build:

```sh
npm install --no-save ../nestarc-inbox-0.2.0.tgz
npm run generate
npm run build
```

The automated test runners always install the tarball built from the checkout, so they exercise the exact candidate artifact. Prisma 7.10.1 uses the PostgreSQL driver adapter and the generated client in `src/generated/prisma`. Version 0.2.0 retains schema v2 and the processing runtime first published in 0.1.0, and adds the optional testing-helper subpath.

## Start a dedicated database

```sh
docker compose -p nestarc-inbox-examples up -d --wait postgres
export INBOX_EXAMPLE_DATABASE_URL='postgresql://example:example@127.0.0.1:55434/inbox_examples'
npm run db:prepare
```

`db:prepare` applies the installed inbox and outbox SQL assets plus the example application tables. It only accepts a loopback database named `inbox_examples` or `inbox_examples_<suffix>`. It does not run Prisma schema synchronization: the package tables are owned by their SQL migrations and are absent from the example Prisma schema.

The Compose database uses temporary storage. Stopping the container discards this fixture. Do not use these commands against an application database.

## Outbox to inbox and downstream delivery

```sh
npm run outbox
```

The application commits an order and an outbox event together. A local outbox listener durably accepts that event into Inbox. Its Inbox handler creates a projection and another outbox event in the same transaction. A second Inbox consumer stores the downstream receipt. Repeating the first input returns `duplicate`.

Expected stable output:

```json
{ "projections": 1, "downstreamReceipts": 1, "duplicateReplay": "duplicate" }
```

No email or external HTTP call is made. `OutboxEmitter` receives the exact transaction supplied by Inbox. Independent consumers have independent durable identities.

## RabbitMQ ingress

```sh
docker compose -p nestarc-inbox-examples up -d --wait rabbitmq
export INBOX_EXAMPLE_AMQP_URL='amqp://guest:guest@127.0.0.1:55672'
npm run rabbitmq
```

The example uses `noAck: false`, prefetch 1, publisher confirms, and durable queues. It publishes two copies with the same stable `messageId` and verifies one projection. ACK follows `accept()` success. The broker delivery tag is never a deduplication key.

Malformed input and identity conflicts go to the run's dead-letter queue. Transient failures before acceptance enter a one-second TTL retry queue, up to three retries. A failed retry publish retains/requeues the original delivery after a pause. Once accepted, handler retries belong solely to Inbox. Each run creates uniquely named fixture queues so unrelated broker data is not changed.

The source and tenant come from trusted route configuration in this fixture. Production applications must authenticate the broker connection and map routes/accounts to tenants themselves.

## Signed webhook ingress

```sh
export INBOX_EXAMPLE_WEBHOOK_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
npm run webhook
```

The example starts an HTTP server on an ephemeral loopback port and sends local fixture requests. It signs raw bytes with a timestamp, checks the HMAC using a constant-time comparison, rejects stale timestamps, and limits the request body. The server maps the authenticated account to a tenant; it never accepts a tenant chosen by the payload.

It asserts that an invalid signature returns 401, the first valid event returns 202, a duplicate returns 200, and the projection appears once. HTTP success means durable acceptance. It does not mean the business handler has already completed.

This HMAC convention is a local example. For a real provider, use that provider's documented raw-body signature and account verification protocol before calling Inbox.

## Cleanup

```sh
docker compose -p nestarc-inbox-examples down
```

The examples close the Nest application before disconnecting the application-owned Prisma client. Database rows can remain across repeated runs while the fixture is running; every run uses fresh event and business IDs.

## Kafka, SQS-compatible, and BullMQ ingress

The repository runner supplies isolated Redpanda (Kafka protocol), Redis, and ElasticMQ (SQS protocol) containers, bound to loopback ports:

```sh
# After installing Inbox in examples/, run from the repository root:
node examples/scripts/with-brokers.cjs
```

It also creates a disposable PostgreSQL database. Each ingress publishes distinct transport deliveries with the same stable producer event ID, injects one pre-acceptance storage failure and one handler failure, checks permanent-input rejection, and asserts one business projection. Only containers created by the runner are removed. The pinned fixtures are Redpanda v26.2.6, Redis 7.4.2, and ElasticMQ 1.7.1. ElasticMQ validates SQS API composition locally; this does not certify AWS IAM, service limits, network failures, or production SQS behavior.

| Example          | Acknowledgment boundary                                                                                                    | Failure handling                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run kafka`  | Commit the next offset only after durable acceptance or confirmed dead-letter publish; process each partition sequentially | Bounded acceptance retries, then confirmed dead-letter publishing before offset advancement; a failed dead-letter publish leaves the offset uncommitted |
| `npm run sqs`    | Delete the delivery only after durable acceptance or confirmed quarantine publish                                          | Failed acceptance retains the message for redelivery; receive-count limit directs repeated failures to the fixture's dead-letter queue                  |
| `npm run bullmq` | Return from the queue processor only after durable acceptance                                                              | BullMQ attempts/backoff handle pre-acceptance failures; permanent input failures are retained as unrecoverable jobs                                     |

The individual commands use `INBOX_EXAMPLE_KAFKA_BROKER`, `INBOX_EXAMPLE_SQS_ENDPOINT`, and `INBOX_EXAMPLE_REDIS_URL` provided by the runner. They require local fixture services. Kafka offsets, SQS receipt handles, and BullMQ job IDs are transport state, not the durable event identity. After acceptance, Inbox handles business retries independently of the transport.

## Tenancy and HTTP idempotency composition

`npm run tenancy` uses actual `TenancyModule`, `TenancyContext`, and `TenancyService` instances with `createInboxTenancyContext`. It creates a restricted PostgreSQL login role, applies the example RLS policies, and verifies tenant-specific reads/writes, cross-tenant rejection, transaction-local setting cleanup, and explicit global shared-table processing. Role creation is fixture setup performed with the dedicated example database owner; the handler role never bypasses RLS. Production policy/role provisioning remains an application migration responsibility.

`npm run idempotency` uses actual `@nestarc/idempotency/postgres` storage at a local HTTP boundary. It verifies cached response replay and conflicting content, waits for the HTTP response record's real expiry, then resends the stable event ID. Inbox still returns `duplicate`, the durable content conflict still receives 422, and the business projection remains singular. HTTP response retention and Inbox receipt retention serve different lifetimes.

## Automated fixture smoke checks

After installing Inbox in `examples/`, run from the repository root:

```sh
node scripts/with-test-db.mjs node examples/scripts/smoke.cjs
node examples/scripts/with-rabbitmq.cjs
```

The first command creates a disposable PostgreSQL instance and runs the outbox and webhook assertions. The second also creates a disposable RabbitMQ instance and runs all three. They remove only the containers they created. Missing Docker or an unhealthy fixture fails the command instead of skipping the checks. These repository runners are development tools; a copied package example can instead use the Compose setup above.
