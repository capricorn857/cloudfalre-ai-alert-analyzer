# Accounts And Operations

## Accounts And Privileges

- Separate read and write identities and make the owning business recognizable.
- DBA accounts start with `dba_`.
- Application accounts use `user_<business>`, with `_r` and `_w` for read-only and write identities where separated.
- Application accounts receive only SELECT, INSERT, and UPDATE by default. Additional privileges require explicit approval.
- Give database credentials only to the database owner. Third parties access data through an owned API rather than direct database access.
- Store credentials in the approved secret system, rotate them, and never place them in source, migration files, command history, or logs.

## Domains And Connections

Applications connect through approved internal DNS, not fixed IP addresses. Keep one or two database cluster domains and use environment and role markers consistently:

```text
user-logs.mysql.ppdaidb.com
fat.user-logs.mysql.ppdaidb.com
pre.user-logs.mysql.ppdaidb.com
user-logs-slave.mysql.ppdaidb.com
user-logs-etl.mysql.ppdaidb.com
```

Use connection pooling with bounded pool size, acquisition timeout, connection lifetime, health checks, and metrics. Size pools against total application instances and database connection capacity, not per-process convenience.

## Replicas

Do not depend on a read replica for correctness-sensitive reads without an explicit stale-read strategy. Replicas can lag and may not provide the same availability as the primary.

- Use replicas for non-critical administration, reporting, or statistics when stale data is acceptable.
- Define primary fallback, lag thresholds, health detection, and behavior after writes.
- Never promise read-your-write semantics from an asynchronously replicated node without routing or synchronization that provides it.

## Operational Review

For risky SQL, inspect locks, deadlocks, replication delay, connection saturation, buffer and disk pressure, query latency, and error rates. Define thresholds and an accountable operator before execution.

The Skill does not authorize production access or mutation. Follow the environment's approval process and show the exact target and SQL before any live change.

