# Sustained ingress, recovery, and retention on a disk-backed database

This report records two local runs of the `0.2.0` candidate. Each run uses a fresh PostgreSQL container and a dedicated Docker volume, with simultaneous receipt acceptance and worker processing. The runs exercise a bounded overload and recovery window; they are not a production capacity estimate or an hours-long soak test.

## Workload and environment

| Setting           | Value                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Node / Prisma     | 24.22.1 / 7.10.1                                                                               |
| PostgreSQL        | 16.15, official `postgres:16-alpine` image                                                     |
| Host              | macOS arm64, Apple M1 Pro, 10 logical CPUs                                                     |
| Docker            | 29.9.2; database limited to 2 CPUs and 1 GiB                                                   |
| Database storage  | Fresh named volume on the Docker VM disk; no PostgreSQL tmpfs                                  |
| Durability        | `fsync`, `synchronous_commit`, and `full_page_writes` enabled                                  |
| Existing history  | 5,000 completed receipts with retained 1 KiB payload bodies                                    |
| Ingress           | 120 seconds: 30 s at 80/s, 60 s at 240/s, 30 s at 80/s                                         |
| Concurrency       | At most 16 acceptance requests, 4 handler tasks                                                |
| Worker polling    | Continuous awaited `runOnce()` calls, with a 5 ms pause after an empty poll                    |
| Connections       | Shared application pool of 8; separate measurement pool of 2                                   |
| Pool pressure     | Hold 4 application connections from about second 48 to 78                                      |
| Tenants           | One hot tenant receives 95%; one cold tenant receives 5%                                       |
| Handler           | 15 ms SQL sleep followed by one business insert in the inbox transaction                       |
| Retry             | Every 50th message within each tenant fails after its first insert, forcing rollback and retry |
| Recovery deadline | 180 seconds after ingress stops                                                                |
| Retention         | Purge completed payloads in batches of 500, then ordinary `VACUUM (ANALYZE)`                   |

The effect table has an independent sequence primary key. Inbox IDs and message IDs have no unique constraint in that table, so duplicate committed effects cannot be hidden by a business uniqueness check. Verification checks every accepted receipt for exactly one committed effect and a completed status, as well as the expected retries and zero unexpected errors.

Receipt payloads use 64 random 1 KiB bodies. The acceptance scheduler is bounded: when all 16 request slots are occupied, it waits rather than generating an unbounded client queue. The JSON reports distinguish target submissions, actual attempts, accepted receipts, and unsent target submissions. Sampled pool queue depth and measured connection acquisition time describe this shared pool; they do not measure a remote production pool.

## Results

Both runs passed. Across **38,398 accepted receipts**, the database contained exactly **38,398 completed receipts and business effects**, with zero missing or duplicate committed effects. The **770 intentional first-attempt failures** rolled back and retried successfully. There were no unexpected acceptance, worker, lease-loss, or DEAD outcomes.

| Measurement                                       |                      Run 1 |                      Run 2 |
| ------------------------------------------------- | -------------------------: | -------------------------: |
| Accepted / completed / business effects           |   19,199 / 19,199 / 19,199 |   19,199 / 19,199 / 19,199 |
| Intentional rollbacks and retries                 |                        385 |                        385 |
| Receive requests/s during the 120 s ingress phase |                    159.992 |                    159.991 |
| Acceptance p50 / p95 / p99                        | 3.480 / 20.615 / 25.915 ms | 3.573 / 21.736 / 27.094 ms |
| Shared-pool acquisition p95 / p99                 |         11.084 / 20.255 ms |         11.652 / 21.132 ms |
| One-second samples with queued pool acquisition   |                         25 |                         22 |
| Highest sampled pool queue depth                  |                          6 |                          6 |
| Highest sampled backlog                           |                      7,613 |                      7,750 |
| Backlog when ingress stopped                      |                      7,573 |                      7,676 |
| Recovery after ingress stopped                    |                   94.675 s |                   94.191 s |
| Total ingress plus recovery                       |                  214.675 s |                  214.191 s |
| Cold tenant completed / completion p95            |             960 / 95.571 s |             960 / 95.478 s |
| Hot tenant completed / completion p95             |          18,239 / 95.574 s |          18,239 / 95.483 s |
| Missing / duplicate committed effects             |                      0 / 0 |                      0 / 0 |

Both offered schedules had 19,200 boundary-inclusive target slots. The strict 120-second cutoff submitted 19,199 of them; the unsubmitted final slot is recorded in each JSON rather than counted as an accepted message. The approximate 160/s receipt rate is the configured mixed offered load, not a maximum-throughput finding. The 95-second completion p95 includes accumulated queue delay under the deliberate overload; it is distinct from the acceptance latency.

The original reports preserve every one-second sample, exact counters, environment details, and latency distributions:

- [Run 1](2026-10-28-sustained-run1.json): completed at `2026-10-28T13:21:12.858Z` / 22:21:12.858 KST.
- [Run 2](2026-10-28-sustained-run2.json): completed at `2026-10-28T13:25:04.040Z` / 22:25:04.040 KST.

Both used image ID `sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36`. Each runner exited successfully, and a final inspection found no remaining benchmark-labeled containers or volumes. Earlier 10-second harness development checks are not included in these measurements.

## Retention guidance

Payload cleanup preserves the receipt identity and fingerprint. The benchmark re-delivers 40 original envelopes after cleanup and checks that they remain duplicates with the original completed receipt and no new business effect. It also compares a checksum of every stored receipt ID and fingerprint before and after cleanup.

| Storage measurement                                   |             Run 1 |             Run 2 |
| ----------------------------------------------------- | ----------------: | ----------------: |
| Seeded history: 5,000 receipts, total relation size   |          7.98 MiB |          7.98 MiB |
| Completed receipts before cleanup                     |            24,199 |            24,199 |
| Logical payload storage before → after cleanup        |     24.55 → 0 MiB |     24.55 → 0 MiB |
| Heap before cleanup                                   |         44.68 MiB |         44.98 MiB |
| Indexes before → after cleanup                        |  9.75 → 10.31 MiB |  9.70 → 10.39 MiB |
| Total relation size before → after cleanup and vacuum | 54.48 → 55.04 MiB | 54.73 → 55.41 MiB |
| Cleanup time, 500-row batches                         |        723.099 ms |        715.353 ms |
| Receipt/fingerprint checksum preserved                |               Yes |               Yes |
| Duplicate re-delivery probes after cleanup            |           40 / 40 |           40 / 40 |

The growth includes receipt insertion, claim/completion updates, intentional retries, and index maintenance. It is not a stable bytes-per-message coefficient for other applications. Cleanup removed all logical payload bytes but left physical allocation available for reuse; the small index increase during cleanup is included rather than hidden.

Use bounded purge batches and measure table, index, and WAL growth in the application workload. Deleting a payload does not remove the deduplication identity or its indexes. Ordinary vacuum makes dead tuple space reusable and does not promise that allocated relation bytes shrink immediately. Retention capacity therefore needs to account for continuing receipt and index growth even when payloads are purged.

The hot/cold tenant measurements expose queue delay under shared scheduling. They do not establish a fairness bound. A tenant with low traffic can still wait behind accumulated work; measure the application's tail latency before choosing any additional scheduling policy.

## Reproduce

With Docker running and repository dependencies installed:

```sh
npm run benchmark:sustained --silent > /tmp/inbox-sustained-run1.json
npm run benchmark:sustained --silent > /tmp/inbox-sustained-run2.json
```

The runner builds the current checkout and generates the test Prisma client. Setup and progress go to stderr; stdout contains only the JSON report. It ignores an existing application `DATABASE_URL`, creates a randomly named database, binds its port only on loopback, and removes its own container and volume in cleanup. The database is capped at 2 CPUs and 1 GiB; commands and the benchmark child have bounded execution times.

For a short harness check, use `INBOX_BENCHMARK_SECONDS=10`. Allowed ingress durations are 10–300 seconds; `INBOX_BENCHMARK_RECOVERY_SECONDS` is also bounded to 10–300 seconds. `INBOX_BENCHMARK_RETAINED` controls the seeded history, from 0 to 50,000 receipts. A run exits unsuccessfully if correctness checks fail or the intended pool-queue/backlog conditions were not observed.

## Interpretation limits

- Two runs on one local Docker VM cover a several-minute overload and recovery window. They do not replace application-specific soak tests or a production capacity plan.
- The volume is disk-backed, but host/VM caches and virtualized flush behavior remain. This is not a cold-cache or physical disk I/O benchmark.
- Intentional SQL delay and retries make the backlog observable. The recorded throughput is specific to that handler and is not the package's maximum throughput.
- The ingress target is an offered schedule with bounded concurrency; actual acceptance throughput and missed targets are reported separately.
- Tenant results describe this 95/5 mix and the current shared scheduling behavior. No fairness SLA is claimed.
- This workload excludes broker traffic, RLS hooks, outbox writes, network faults, and failover. Separate operational scenarios verify those behaviors.
- Other repository test containers were stopped before the measured runs. Unrelated host activity was not controlled.
