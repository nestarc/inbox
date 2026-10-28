# Preview 1 local performance measurements

Measured on **28 October 2026, 20:49 KST**, using `@nestarc/inbox` **0.1.0-preview.1** and inbox **SQL schema version 2**. Three complete benchmark invocations ran serially, each against a newly created disposable PostgreSQL container. Every result is reported, including the slower fresh-table result in run 3.

The measurements show the cost of durable receipt acceptance and a separate worker drain with one small database write per message. They do not establish sustained production capacity or a latency SLA.

## Observed ranges across all three runs

These are minimum–maximum values from the three runs, not confidence intervals. The p95 range describes three separately calculated p95 values; it is not a pooled percentile of all requests.

| Scenario                                      |  Receive requests/s |     Receive p95 | Worker completions/s |  Worker drain time |
| --------------------------------------------- | ------------------: | --------------: | -------------------: | -----------------: |
| Fresh table, 500 unique messages              | 1,400.499–2,123.920 | 5.286–11.612 ms |      531.734–542.775 | 921.193–940.319 ms |
| 10,000 retained receipts, 500 unique messages | 2,331.351–2,467.967 |  4.602–5.275 ms |      543.328–561.850 | 889.917–920.254 ms |
| 10,000 retained receipts, 90% duplicates      | 1,812.640–2,061.929 |  5.290–6.622 ms |      523.475–561.857 |   88.991–95.516 ms |

**All nine scenario results passed their correctness checks.** Across 4,500 receive calls, the benchmark observed 3,150 newly accepted messages, 1,350 duplicate receipts, and exactly 3,150 committed business effects. No acceptance or worker errors were observed. Each scenario finished with the expected completed count and no pending, processing, retryable, or dead records.

Receive requests/s includes both newly accepted and duplicate calls. It measures `accept()` returning after its receipt transaction, **before business processing**. After the receive phase finishes, the benchmark calls `runOnce()` repeatedly to drain the backlog. Worker completions/s measures unique committed effects divided by that drain duration, including claims, handler transactions, fenced completion, and the final empty poll. The duplicate scenario drains only 50 unique messages rather than 500, so its shorter drain is not evidence of faster processing per message.

## Every measured run

| Run | Scenario                        | Receive requests/s | Receive p95 | Worker completions/s | Worker drain time | Accepted / duplicate |
| --- | ------------------------------- | -----------------: | ----------: | -------------------: | ----------------: | -------------------: |
| 1   | Fresh unique                    |          2,123.920 |    5.286 ms |              531.734 |        940.319 ms |              500 / 0 |
| 1   | Retained 10,000, unique         |          2,331.351 |    5.275 ms |              543.328 |        920.254 ms |              500 / 0 |
| 1   | Retained 10,000, 90% duplicates |          1,812.640 |    5.901 ms |              523.475 |         95.516 ms |             50 / 450 |
| 2   | Fresh unique                    |          2,117.532 |    5.406 ms |              538.703 |        928.155 ms |              500 / 0 |
| 2   | Retained 10,000, unique         |          2,467.967 |    5.244 ms |              561.850 |        889.917 ms |              500 / 0 |
| 2   | Retained 10,000, 90% duplicates |          1,864.466 |    6.622 ms |              547.005 |         91.407 ms |             50 / 450 |
| 3   | Fresh unique                    |          1,400.499 |   11.612 ms |              542.775 |        921.193 ms |              500 / 0 |
| 3   | Retained 10,000, unique         |          2,358.995 |    4.602 ms |              558.711 |        894.918 ms |              500 / 0 |
| 3   | Retained 10,000, 90% duplicates |          2,061.929 |    5.290 ms |              561.857 |         88.991 ms |             50 / 450 |

The original JSON reports include p50, p99, elapsed times, exact counters, error maps, and environment metadata:

- [Run 1](2026-10-28-preview1-run1.json), completed at `2026-10-28T11:49:05.582Z` / 20:49:05.582 KST.
- [Run 2](2026-10-28-preview1-run2.json), completed at `2026-10-28T11:49:36.479Z` / 20:49:36.479 KST.
- [Run 3](2026-10-28-preview1-run3.json), completed at `2026-10-28T11:49:53.903Z` / 20:49:53.903 KST.

Each JSON is preserved from the benchmark's output, with the outer runner's setup log removed. The JSON's single-sample limitation applies to that individual invocation; this document combines three such invocations without dropping any sample.

## Environment and workload

| Setting                                   | Value                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Package / schema                          | `0.1.0-preview.1` / SQL version 2                                                  |
| Node.js                                   | `24.22.1`                                                                          |
| NestJS / Prisma                           | `11.2.8` / `7.10.1`                                                                |
| PostgreSQL                                | `16.15`, aarch64 Linux musl                                                        |
| Host                                      | macOS arm64, Apple M1 Pro, 10 logical CPUs                                         |
| Docker engine                             | `29.8.2`, 10 CPUs and 8,319,504,384 bytes of memory reported by Docker             |
| PostgreSQL image                          | `postgres:16-alpine`                                                               |
| Image digest                              | `postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36` |
| Storage and transport                     | Docker tmpfs database; loopback forwarded TCP                                      |
| Prisma pool / fixture administration pool | Maximum 12 / 2 connections                                                         |
| Receive / worker concurrency              | 8 / 4                                                                              |
| Receive calls per scenario                | 500                                                                                |
| JSON payload                              | 265 UTF-8 bytes                                                                    |
| Retained history                          | 10,000 completed receipts with payloads purged                                     |
| Worker effect                             | One `INSERT` in the same Prisma transaction as inbox completion                    |
| Automatic polling                         | Disabled; explicit bounded `runOnce()` drain                                       |

Each scenario truncates the fixture tables, optionally seeds retained receipts, runs `ANALYZE`, and issues concurrent `SELECT 1` queries to establish connections. This preparation is excluded from the timing. There are no warmup inbox writes. Within each invocation, scenarios always run in this order: fresh unique, retained unique, retained with 90% duplicates.

## Reproduce

With Docker running and the repository dependencies installed:

```sh
npm run benchmark
npm run benchmark
npm run benchmark
```

Use Node.js `24.22.1` to match this measurement. The runs here used that runtime with the npm cache set to `/private/tmp/nestarc-inbox-npm-cache`; the cache location does not affect the timed database operations.

[The benchmark](../../scripts/benchmark.mjs) builds the package and uses [the fixture runner](../../scripts/with-test-db.mjs) to create a database on a random loopback port. The runner ignores an existing application `DATABASE_URL`, generates the test Prisma client, and removes its container afterward. All three invocations exited successfully and no labeled inbox fixture containers remained after the measurements.

## Interpretation limits

- Three short samples reveal some local variation, not a reliable estimate of long-running throughput. Run 3's fresh-table receive rate and p95 illustrate that variation; its cause was not measured.
- Fixed scenario order allows later cases to benefit from process/JIT/cache warmup. These results do not imply that retaining more receipts makes the package faster.
- A tmpfs database, loopback networking, 265-byte payloads, and one simple business write differ from disk-backed production databases, remote services, larger payloads, and application handlers.
- Receive and worker phases run separately. This does not measure concurrent ingress and processing under a sustained backlog, pool saturation, or backpressure.
- Replay, tenancy/RLS hooks, outbox emission, broker traffic, network faults, cold caches, and tenant fairness are not exercised by this benchmark. Their correctness tests are separate evidence.
- The older Preview 0 report used a different Node version and code/schema. This is a fresh baseline, not a controlled before/after comparison or a comparison with other products.
