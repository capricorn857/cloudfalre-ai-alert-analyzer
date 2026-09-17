# Indexes And Queries

## Index Requirements

- Business uniqueness is enforced with a unique index even when the application checks first.
- Unique indexes use `uniq_column[_column]`; ordinary indexes use `idx_column[_column]`.
- An index contains at most five columns and must not duplicate the primary key or another index prefix without evidence.
- VARCHAR indexes specify an appropriate prefix length when full length is unnecessary. Use measured selectivity, for example `COUNT(DISTINCT LEFT(column, n)) / COUNT(*)`.
- Logical association columns use identical types and indexes on the joined side.
- Put equality predicates before range predicates in composite indexes. Among equality predicates, prefer higher selectivity first.
- Align trailing index columns with stable `ORDER BY` requirements and consider covering indexes for frequent read paths.

Index order, selectivity, redundancy, and covering strategy require query and data-distribution evidence.

## Query Rules

- Join no more than three tables in one query. Qualify selected, filtered, grouped, ordered, updated, and deleted columns whenever multiple tables participate.
- Do not use left or full wildcard search (`LIKE '%term'` or `LIKE '%term%'`) for page search; use an approved search engine.
- Keep literal `IN` lists at or below 1000 values. Prefer a temporary table, batch, or join for larger sets.
- Avoid implicit type conversion between predicates and indexed columns.
- Use `COUNT(*)` for row counts. Understand that `COUNT(column)` excludes NULL and multi-column DISTINCT has NULL semantics.
- Use `IS NULL` and `IS NOT NULL`, not equality or inequality comparisons with NULL.
- Wrap nullable aggregates when the contract requires a number, for example `IFNULL(SUM(amount), 0)`.
- If a count query returns zero, skip the associated page-data query.

## Pagination And Plans

Avoid high offsets. Prefer keyset pagination or first locate the primary-key range and then fetch rows. Always use deterministic ordering.

Run `EXPLAIN` for new or materially changed production queries. Review:

- chosen key and key length;
- access type, aiming for `ref`, `range`, or `const` where the workload permits;
- estimated rows and filtering;
- `Using filesort`, temporary tables, and full scans;
- whether range predicates prevent later index ordering.

An access type alone is not approval. Evaluate result size, frequency, data distribution, concurrency, and measured latency.

## Transactions And Locks

- Keep transactions small and short; the source standard caps transaction payload at 20 MB.
- Acquire locks in a consistent order and avoid user interaction or remote calls inside transactions.
- Analyze deadlocks from engine diagnostics and fix access order, index coverage, or transaction scope rather than blindly retrying forever.
- Apply bounded retry only to safe, idempotent operations.

