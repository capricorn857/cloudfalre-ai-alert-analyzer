# Database And Migrations

## Logical Foreign Keys

Database tables and SQLAlchemy Models must not declare physical `FOREIGN KEY` constraints.

- Represent associations with scalar `{entity}_id` columns and indexes.
- Service validates referenced records and owns consistency, concurrency, and deletion behavior.
- Do not rely on `ON DELETE`, ORM delete cascade, or relationship lazy loading.
- Prefer soft deletion for business entities; specify any physical deletion and orphan handling in the feature spec.
- A unique business invariant still requires an appropriate unique index.

## AsyncSession And Transactions

- Use SQLAlchemy 2.x async statements with an approved async MySQL driver.
- Create an independent `AsyncSession` for each request and each concurrent task.
- Never share a Session across requests, threads, Celery tasks, or branches of `asyncio.gather()`.
- Service wraps a complete business operation in `async with session.begin()`.
- Repositories participating in one transaction receive the same Session.
- Repository may call `flush()` and `refresh()` when needed, but never `commit()` or `rollback()`.
- Avoid lazy loading and other implicit I/O. Load required data explicitly.

Database URLs and credentials come from controlled configuration. Configure pool health checks and recycle settings, and dispose the engine during application shutdown.

## Query And Index Rules

- Select only fields required by the contract for large or frequent queries.
- Avoid N+1 queries; use explicit eager loading or dedicated queries without introducing physical foreign keys.
- Bound pagination size and define a stable ordering.
- Use keyset pagination for high-offset or high-volume flows where appropriate.
- Add indexes for frequent filters, joins through logical IDs, uniqueness, and stable ordering.
- Validate MySQL-specific SQL, locks, isolation, and query plans on MySQL rather than SQLite.

## SQL Migration System

Store migrations under `migrations/sql/`:

```text
017_add_order_status.sql
018_add_order_lookup_index_notx.sql
```

- `NNN_description.sql` is the normal form.
- `NNN_description_notx.sql` is reserved for reviewed Online DDL.
- Record filename, SHA256 checksum, and application time in `schema_migrations`.
- An applied file is immutable across every environment: never edit, delete, rename, or reorder it.
- Fixes use a new higher-numbered forward migration that complies with the team MySQL migration standard. Application migrations must not use DROP or TRUNCATE as a reversal mechanism.
- A checksum mismatch stops deployment; never repair it by directly editing migration history.

MySQL DDL commonly performs implicit commits. Do not promise transactional rollback for DDL, and design multi-statement recovery for partial success.

For Online DDL:

- evaluate table size, metadata locks, replication delay, duration, and recovery;
- explicitly request the approved algorithm and lock behavior;
- stop and re-review if MySQL cannot honor `LOCK=NONE`;
- merge compatible changes to the same table when that reduces rebuilds and locks;
- test against production-like schema and data volume.

For data corrections:

- run a `SELECT` with the exact target predicate first;
- record and review expected affected rows;
- set timeouts and row limits;
- batch large changes and monitor locks and replication;
- reject unbounded `UPDATE`, `DELETE`, and application `TRUNCATE`.

Idempotent DDL uses supported conditional clauses. When MySQL cannot express a safe conditional operation, the migration runner checks `INFORMATION_SCHEMA` before execution; do not create stored procedures solely to emulate `IF NOT EXISTS`.
