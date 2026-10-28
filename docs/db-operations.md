# PostgreSQL failover and disk exhaustion tests

The [2026-10-28 local run](operations/2026-10-28-database.json) passed both scenarios with Node 24.22.1, Docker 29.9.2, and the `postgres:16-alpine` image. Standby promotion plus lease recovery took 1,979 ms; retry after freeing the full tablespace took 25 ms. All created containers and the private network were removed. These are single local observations, not recovery-time guarantees.

Run the isolated operational suite with a running Docker engine and installed repository dependencies:

```sh
npm run test:operations:database
```

The runner builds the current checkout and generates the fixture Prisma client. It ignores application `DATABASE_URL` values and creates its own random database, credentials, Docker network, and loopback-only ports. Every container is labeled and limited to one CPU, 768 MiB of memory, and a 512 MiB tmpfs PostgreSQL data directory. A separate 16 MiB tmpfs is used for the disk-full scenario. No host data directory is mounted and the test cannot fill the host filesystem.

Each command and readiness wait is bounded. The runner removes only the container IDs and network ID that it created, including on assertion failures. Its JSON report contains scenario results, timing, and cleanup status. Set `INBOX_DB_OPERATIONS_REPORT` to a new file path to preserve the same JSON; the runner refuses to overwrite an existing report.

## Primary failure and standby promotion

The runner starts PostgreSQL 16 primary and standby servers. `pg_basebackup -R -X stream` initializes physical streaming replication. The test then creates three receipts:

- A completed receipt with committed business and outbox fixture rows.
- A claimed receipt whose handler has written business and outbox rows inside an uncommitted transaction.
- A pending receipt accepted while the other handler is paused.

Before killing the primary with `SIGKILL`, the test waits until the standby has replayed the primary's flushed WAL position covering the accepted receipts and claim. It verifies that the paused handler's uncommitted effects are invisible on the standby. The standby is then promoted using `pg_promote()`, and a new application-owned Prisma client connects to the promoted server.

The test checks that redelivery of all three messages remains a duplicate, the completed receipt is preserved, and the abandoned claim is recovered after its real lease expires. Each receipt must finish with exactly one business row and one outbox row. These fixture tables deliberately have no uniqueness constraint that could mask duplicate committed effects. The abandoned receipt must have two attempts.

This verifies recovery **after the tested WAL position has reached the standby**. Asynchronous replication can lose transactions that have not reached the failover target. The test does not claim zero data loss for arbitrary failover, automatic endpoint discovery, a high-availability control plane, or rejoining the old primary. The old primary stays stopped, preventing split brain. Applications and database infrastructure own replication durability, endpoint routing, fencing, and restoration policies.

## Real PostgreSQL disk-full failure

A separate PostgreSQL instance has a tablespace on a **16 MiB tmpfs mount**. The test fills a ballast table with uncompressed one-MiB values until PostgreSQL returns SQLSTATE `53100` (`disk_full`). The insertion loop has a maximum of 32 attempts.

An Inbox handler writes its business and outbox fixture rows and then attempts to write to the exhausted tablespace in the same transaction. The test requires that processing becomes `RETRYABLE`, no business or outbox effect commits, and the failed tablespace write leaves no visible row. It then drops its disposable ballast table, truncates its disposable business table, retries the receipt, and verifies one committed set of effects, exactly two attempts, and duplicate handling on redelivery.

This exercises actual data-tablespace ENOSPC and recovery. WAL-volume, system-catalog-volume, inode exhaustion, cloud storage quotas, and a full host filesystem are different failure modes and are not covered here. The test intentionally leaves enough space for PostgreSQL and Inbox's retry-state storage to remain available.

## References

- [PostgreSQL streaming replication and standby operation](https://www.postgresql.org/docs/16/warm-standby.html)
- [PostgreSQL pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html)
- [PostgreSQL error codes](https://www.postgresql.org/docs/16/errcodes-appendix.html)
