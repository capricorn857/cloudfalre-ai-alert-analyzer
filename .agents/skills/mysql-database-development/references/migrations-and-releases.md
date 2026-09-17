# Migrations And Releases

## Database And Object Restrictions

- Never execute `ALTER DATABASE` or `DROP DATABASE` through an application migration.
- Never create or replace views, stored procedures, functions, triggers, partitioned tables, or physical foreign keys.
- Never use DROP or TRUNCATE in application migrations.
- `ALTER TABLE` is allowed only in a reviewed, versioned migration with an execution and recovery plan.

## Migration Review

Before approval, record:

- target environment, database, table, and exact migration file;
- current schema and indexes;
- table size, row count, write rate, replication topology, and available disk;
- metadata-lock and table-rebuild risk;
- Online DDL algorithm and lock behavior supported by the exact MySQL version;
- execution duration estimate, monitoring, abort criteria, and forward-fix plan;
- affected applications, jobs, reports, and data subscribers.

Combine compatible changes to the same table into one ALTER statement to reduce repeated rebuild and metadata-lock exposure.

Applied migration files are immutable. Never edit, delete, rename, or reorder an applied file. Correct mistakes with a new higher-version forward migration. A checksum mismatch blocks release.

The DROP/TRUNCATE prohibition is non-suppressible. A change that cannot be expressed as a compliant forward migration must leave the application-migration workflow and follow the separately authorized DBA emergency process.

## Data Corrections

Before UPDATE or DELETE:

1. Run SELECT with the exact same WHERE clause.
2. Record expected affected rows and representative records.
3. Obtain independent review.
4. Define timeout, batch size, transaction size, monitoring, and recovery.
5. Execute in bounded batches and compare actual affected rows with the approved count.

UPDATE or DELETE without WHERE is prohibited. Large corrections must stay below the 20 MB transaction limit and avoid long lock retention.

## Release Process

Normal DDL windows are Tuesday, Thursday, and Friday from 21:00 through 06:00. Outside that window, use the emergency release process.

Changing a field's meaning or state values requires confirmation from application owners and downstream data subscribers before release. Do not encode this approval as a SQL-only check; attach evidence to the change record.

## Warning Disposition

The checker reports warnings for nullable fields, TIMESTAMP, TEXT/BLOB, `CHANGE COLUMN`, likely type changes, aggregation semantics, and high-offset pagination. Reviewers must record one of:

- accepted with evidence;
- corrected before merge;
- covered by a precise, temporary exception with owner and expiry.

Warnings are not permission to skip review.
