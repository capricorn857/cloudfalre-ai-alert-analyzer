---
name: mysql-database-development
description: Use when designing, creating, changing, reviewing, or troubleshooting MySQL schemas, tables, columns, indexes, SQL queries, data corrections, migrations, database accounts, replicas, or release operations.
---

# MySQL Database Development

## Purpose

Apply the team's MySQL 8.0 standard to schema design, SQL, migrations, releases, and reviews. Deterministic violations are CI-blocking; performance and operational decisions require explicit review evidence.

The user's explicit instructions take precedence. When a request conflicts with a mandatory team rule, identify the conflict rather than silently weakening the rule.

## Load Relevant Guidance

- Read [schema-design.md](references/schema-design.md) for databases, tables, columns, types, comments, logical deletion, and sharding.
- Read [indexes-and-queries.md](references/indexes-and-queries.md) for indexes, joins, pagination, aggregation, NULL, and query performance.
- Read [migrations-and-releases.md](references/migrations-and-releases.md) for DDL, data correction, destructive SQL, migration review, and release windows.
- Read [accounts-and-operations.md](references/accounts-and-operations.md) for accounts, privileges, domains, replicas, connections, locks, and availability.
- Read [ci-integration.md](references/ci-integration.md) when installing or changing the automated gate.

## Workflow

1. Classify the request and read every relevant reference before proposing SQL.
2. Inspect the target MySQL version, current schema, data volume, indexes, callers, and migration history.
3. State schema impact, lock risk, transaction scope, rollback or forward-fix plan, and required reviewers.
4. Write the smallest safe SQL and validate it against representative schema and data.
5. Run the SQL checker and complete the human review items before approval or completion.

Resolve this Skill's directory and run:

```bash
python <skill-dir>/scripts/check_mysql_sql.py <sql-file-or-directory>
```

Every `ERROR` blocks completion and merge. `WARNING` requires a documented review decision. Do not bypass findings because code is legacy, a deadline is close, tests pass, the SQL is small, or a senior requested it. Temporary exceptions require an exact rule and file plus reason, owner, and unexpired date.

Physical foreign keys (`MYSQL007`, `MYSQL015`) and destructive SQL (`MYSQL010`) cannot be suppressed.

## Non-Negotiable Rules

| Area | Required outcome |
|---|---|
| Naming | Lowercase identifiers, start with a letter, maximum 32 characters |
| Table | InnoDB, utf8mb4, utf8mb4_unicode_ci, table and column comments |
| Base fields | `id`, `inserttime`, `updatetime`, `isactive` with standard definitions |
| Indexes | Primary key plus `idx_inserttime`, `idx_updatetime`; `uniq_`/`idx_` names |
| Integrity | No physical foreign keys or database cascades |
| Types | No FLOAT, DOUBLE, ENUM, SET, or BIT |
| Objects | No partitioned tables, views, or stored procedures |
| Destructive SQL | No DROP, TRUNCATE, or UPDATE/DELETE without WHERE |

## Completion Gate

- Checker has zero ERROR findings.
- Every WARNING has an explicit disposition.
- Migration and operational review checklists are complete.
- Tests or dry runs, EXPLAIN evidence, and unavailable checks are reported accurately.
