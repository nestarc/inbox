# RabbitMQ restart and retry recovery

On 2026-10-28, the [operational harness](../scripts/test-broker-recovery.mjs) passed all five scenarios with RabbitMQ 4.4.0, PostgreSQL 16.15, and Node 24.11.1. It killed the actual RabbitMQ process with `SIGKILL` three times and restarted the same container with its persistent data volume. The successful run took 21.752 seconds, excluding the outer PostgreSQL setup. [Raw result](broker-recovery-results.json).

| Scenario                                                                                   | Verified result                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt and business transaction commit, then broker dies before ACK                       | RabbitMQ marks the delivery as redelivered; `accept()` returns the same completed receipt as a duplicate; exactly one business effect remains                                     |
| Admission backpressure, confirmed transfer to the retry queue, then broker dies            | Persistent retry message survives; TTL dead-letter routing returns it to the main queue with retry and `x-death` evidence; processing commits one effect                          |
| Admission remains unavailable through the transport retry budget                           | Four failed acceptance attempts, three confirmed retry transfers, then transport DLQ; no receipt and no business effect were created                                              |
| Invalid JSON or conflicting content for an existing message identity                       | Both are rejected to transport DLQ with `x-death.reason=rejected`; no additional business effect is committed                                                                     |
| Accepted and ACKed messages fail inside the handler, then broker and Inbox service restart | Persisted Inbox retry state survives; transient failure completes on attempt 2; poison message reaches Inbox `DEAD` on attempt 3; failed attempts roll back their business writes |

The final database contains five completed receipts and one DEAD receipt, with no pending, processing, or retryable records. The main, retry, and dead-letter queues are empty after their results are inspected and acknowledged. Business-effect rows have independent UUID primary keys, so duplicate handler commits cannot be hidden by a per-receipt unique constraint.

## Reproduce

Install the repository and example dependencies, then run:

```sh
npm run build
node scripts/with-test-db.mjs node scripts/test-broker-recovery.mjs
```

The script uses `amqplib` from `examples/node_modules`. The database wrapper ignores application database URLs and creates a random loopback-only PostgreSQL fixture. The broker harness creates its own random loopback-only RabbitMQ container and named volume, and removes both in `finally`. It re-reads Docker's published port after each restart because the ephemeral host port can change. It never restarts an existing broker.

## Scope

This is a single-node RabbitMQ classic-queue test with durable queues, persistent messages, publisher confirms, and explicit manual ACKs. It verifies the application's acceptance/ACK and retry routing contract against a real broker. The harness drives each failure boundary explicitly instead of using an automatically reconnecting production consumer. Admission failure is real Inbox backpressure; this test does not substitute a simulated database outage for the separate network and database fault tests.

RabbitMQ cluster partitions, quorum-queue failover, production consumer reconnect policies, Kafka consumer-group rebalances, and AWS SQS remain deployment-specific validation. Transport DLQ and Inbox DEAD are separate states: the former contains messages that were never accepted, while the latter retains accepted messages whose handler exhausted its attempts.
