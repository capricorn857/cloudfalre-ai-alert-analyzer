# Schema Design

## Naming

- Database, table, column, and named-index identifiers use lowercase letters, digits, and underscores, begin with a letter, and do not exceed 32 characters.
- Names describe business meaning. Table names are singular and should follow `business_purpose` where practical.
- Do not use MySQL reserved words or keywords.
- Boolean columns other than the standard logical-delete column use `is_xxx`, `TINYINT UNSIGNED`, and values `1`/`0` with an explicit comment.
- IP-address columns include `ip` in the name and use `VARCHAR(64)` for IPv6 compatibility.

## Required Table Shape

Every business table uses:

```sql
id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键',
inserttime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '插入时间',
updatetime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
isactive TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '逻辑删除(1:保留,0:删除)',
PRIMARY KEY (id),
KEY idx_inserttime (inserttime),
KEY idx_updatetime (updatetime)
```

- Engine is InnoDB.
- Default character set is `utf8mb4` and collation is `utf8mb4_unicode_ci`.
- Every table and column has a meaningful `COMMENT`.
- Do not create composite primary keys, physical foreign keys, partitions, views, or stored procedures.
- Character columns inherit the table character set; do not override it per column.

## Data Types

- Use `DECIMAL(p,s)` for precise values such as money; never FLOAT or DOUBLE.
- Do not use ENUM, SET, or BIT. Store controlled states in documented integer or string columns and validate them in the application.
- Use unsigned integer types for non-negative domains.
- Use CHAR only when values are truly fixed length; otherwise use bounded VARCHAR.
- Keep VARCHAR at or below 5000 characters. Large text belongs in a separate table linked by the primary-key value.
- TEXT/BLOB requires explicit review and warning disposition, with no more than three such columns in one table.
- DATETIME columns require valid nonzero defaults. TIMESTAMP is review-required.
- Default to NOT NULL with a documented default unless NULL has explicit domain meaning.

## Relationships And Deletion

Associations use scalar logical ID columns with matching type and signedness and an appropriate index. The application owns existence checks, consistency, and cascade behavior. Never add `FOREIGN KEY`, `REFERENCES`, or database cascades.

Use `isactive` for standard logical deletion. Any different deletion convention requires an approved project standard and migration plan.

## Sharding And Redundancy

Do not shard preemptively. Consider sharding only when projected scale exceeds roughly 20 million rows or 10 GB per table and operational evidence supports it.

- Date shards use `_YYYY`, `_YYYYMM`, or `_YYYYMMDD` suffixes.
- Hash shard suffixes are zero-based, decimal, underscore-separated, zero-padded, and consistent across databases.
- Redundant fields must be stable, non-unique, not large VARCHAR/TEXT, and have an explicit consistency owner and update strategy.

These are review decisions, not conclusions inferred from DDL alone.
