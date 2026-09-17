#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal, Sequence

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

Severity = Literal["ERROR", "WARNING"]
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
FORBIDDEN_TYPES = {"FLOAT", "DOUBLE", "ENUM", "SET", "BIT"}
SUPPRESSIBLE = (
    {f"MYSQL{number:03d}" for number in range(1, 106)}
    - {"MYSQL007", "MYSQL010", "MYSQL015", "MYSQL100"}
)


@dataclass(frozen=True, order=True)
class Finding:
    path: Path
    line: int
    column: int
    rule: str
    severity: Severity
    message: str

    def render(self) -> str:
        return f"{self.path}:{self.line}:{self.column}: {self.severity} {self.rule} {self.message}"


def location(node: exp.Expression | None) -> tuple[int, int]:
    meta = node.meta if node is not None else {}
    return int(meta.get("line", 1)), int(meta.get("col", 1))


def finding(path: Path, node: exp.Expression | None, rule: str, severity: Severity, message: str) -> Finding:
    line, column = location(node)
    return Finding(path, line, column, rule, severity, message)


def constraints(column: exp.ColumnDef) -> list[exp.Expression]:
    return [item.args.get("kind") for item in column.args.get("constraints", [])]


def has_constraint(column: exp.ColumnDef, kind: type[exp.Expression]) -> bool:
    return any(isinstance(item, kind) for item in constraints(column))


def get_constraint(column: exp.ColumnDef, kind: type[exp.Expression]) -> exp.Expression | None:
    return next((item for item in constraints(column) if isinstance(item, kind)), None)


def dtype(column: exp.ColumnDef) -> str:
    value = column.args["kind"].args.get("this")
    return getattr(value, "value", str(value)).upper()


def property_value(create: exp.Create, kind: type[exp.Expression]) -> str | None:
    properties = create.args.get("properties")
    if not properties:
        return None
    item = next((value for value in properties.expressions if isinstance(value, kind)), None)
    return str(item.args.get("this")).strip("'") if item else None


def check_create_table(path: Path, create: exp.Create, clean: str) -> list[Finding]:
    out: list[Finding] = []
    schema = create.this
    table = schema.this if isinstance(schema, exp.Schema) else schema
    table_name = table.name
    if not IDENTIFIER.fullmatch(table_name):
        out.append(finding(path, table, "MYSQL001", "ERROR", "invalid table identifier"))

    columns = list(schema.find_all(exp.ColumnDef)) if isinstance(schema, exp.Schema) else []
    for column in columns:
        if not IDENTIFIER.fullmatch(column.name):
            out.append(finding(path, column, "MYSQL001", "ERROR", f"invalid column identifier {column.name}"))
        comment = get_constraint(column, exp.CommentColumnConstraint)
        if not comment or not str(comment.args.get("this")).strip("'"):
            out.append(finding(path, column, "MYSQL002", "ERROR", f"column {column.name} requires COMMENT"))
        column_type = dtype(column)
        if column_type in FORBIDDEN_TYPES:
            out.append(finding(path, column, "MYSQL008", "ERROR", f"type {column_type} is forbidden"))
        if column_type in {"TEXT", "BLOB"}:
            out.append(finding(path, column, "MYSQL101", "WARNING", f"{column.name} uses {column_type}"))
        if column_type == "TIMESTAMP" or not has_constraint(column, exp.NotNullColumnConstraint):
            out.append(finding(path, column, "MYSQL101", "WARNING", f"review nullability/time type for {column.name}"))
        if column.name.startswith("is_") and column_type != "UTINYINT":
            out.append(finding(path, column, "MYSQL102", "WARNING", f"{column.name} should be TINYINT UNSIGNED"))

    props = {
        "engine": property_value(create, exp.EngineProperty),
        "charset": property_value(create, exp.CharacterSetProperty),
        "collation": property_value(create, exp.CollateProperty),
        "comment": property_value(create, exp.SchemaCommentProperty),
    }
    if props["engine"].lower() != "innodb" if props["engine"] else True:
        out.append(finding(path, create, "MYSQL002", "ERROR", "table requires ENGINE=InnoDB"))
    if (props["charset"] or "").lower() != "utf8mb4" or (props["collation"] or "").lower() != "utf8mb4_unicode_ci" or not props["comment"]:
        out.append(finding(path, create, "MYSQL002", "ERROR", "table requires utf8mb4, utf8mb4_unicode_ci, and COMMENT"))

    by_name = {column.name: column for column in columns}
    primary = list(schema.find_all(exp.PrimaryKey)) if isinstance(schema, exp.Schema) else []
    id_column = by_name.get("id")
    primary_names = [item.name for item in primary[0].expressions] if len(primary) == 1 else []
    if not id_column or dtype(id_column) != "UBIGINT" or not has_constraint(id_column, exp.NotNullColumnConstraint) or not has_constraint(id_column, exp.AutoIncrementColumnConstraint) or primary_names != ["id"]:
        out.append(finding(path, id_column or create, "MYSQL003", "ERROR", "primary key must be id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT"))

    required = {"inserttime": "DATETIME", "updatetime": "DATETIME", "isactive": "UTINYINT"}
    for name, expected in required.items():
        column = by_name.get(name)
        if not column or dtype(column) != expected or not has_constraint(column, exp.NotNullColumnConstraint) or not has_constraint(column, exp.DefaultColumnConstraint):
            out.append(finding(path, column or create, "MYSQL004", "ERROR", f"missing or invalid required column {name}"))
    isactive = by_name.get("isactive")
    isactive_default = get_constraint(isactive, exp.DefaultColumnConstraint) if isactive else None
    if isactive_default and str(isactive_default.args.get("this")) not in {"1", "'1'"}:
        out.append(finding(path, isactive, "MYSQL004", "ERROR", "isactive DEFAULT must be 1"))
    if by_name.get("updatetime") and not has_constraint(by_name["updatetime"], exp.OnUpdateColumnConstraint):
        out.append(finding(path, by_name["updatetime"], "MYSQL004", "ERROR", "updatetime requires ON UPDATE CURRENT_TIMESTAMP"))

    index_columns: dict[str, list[str]] = {}
    for index in schema.expressions if isinstance(schema, exp.Schema) else []:
        if isinstance(index, exp.IndexColumnConstraint):
            name, count = index.name, len(index.expressions)
            index_columns[name] = [item.this.name for item in index.expressions]
            if not name.startswith("idx_") or count > 5:
                out.append(finding(path, index, "MYSQL006", "ERROR", f"invalid ordinary index {name}"))
        elif isinstance(index, exp.UniqueColumnConstraint):
            name = index.this.this.name if isinstance(index.this, exp.Schema) else index.name
            if not name.startswith("uniq_") or len(index.this.expressions) > 5:
                out.append(finding(path, index, "MYSQL006", "ERROR", f"invalid unique index {name}"))
    for required_index in ("idx_inserttime", "idx_updatetime"):
        expected_column = required_index.removeprefix("idx_")
        if index_columns.get(required_index) != [expected_column]:
            out.append(finding(path, create, "MYSQL005", "ERROR", f"missing {required_index}"))

    large_count = sum(dtype(column) in {"TEXT", "BLOB"} for column in columns)
    if large_count > 3:
        out.append(finding(path, create, "MYSQL009", "ERROR", "at most three TEXT/BLOB columns are allowed"))
    if create.find(exp.ForeignKey) or re.search(r"\bPARTITION\s+BY\b", clean, re.I):
        out.append(finding(path, create, "MYSQL007", "ERROR", "foreign keys and partitioned tables are forbidden"))
    return out


def check_statement(path: Path, statement: exp.Expression, clean: str) -> list[Finding]:
    out: list[Finding] = []
    if isinstance(statement, exp.Create):
        kind = (statement.args.get("kind") or "").upper()
        if kind == "TABLE":
            out.extend(check_create_table(path, statement, clean))
        elif kind in {"VIEW", "PROCEDURE", "FUNCTION", "TRIGGER"}:
            out.append(finding(path, statement, "MYSQL007", "ERROR", f"CREATE {kind} is forbidden"))
    if isinstance(statement, (exp.Drop, exp.TruncateTable)) or (isinstance(statement, exp.Alter) and (statement.args.get("kind") or "").upper() == "DATABASE"):
        out.append(finding(path, statement, "MYSQL010", "ERROR", "destructive database operation is forbidden"))
    if isinstance(statement, (exp.Update, exp.Delete)) and statement.args.get("where") is None:
        out.append(finding(path, statement, "MYSQL010", "ERROR", "UPDATE/DELETE requires WHERE"))
    for like in statement.find_all(exp.Like):
        value = like.expression
        if isinstance(value, exp.Literal) and value.is_string and value.this.startswith("%"):
            out.append(finding(path, like, "MYSQL011", "ERROR", "left/full wildcard search is forbidden"))
    for item in statement.find_all(exp.In):
        if len(item.expressions) > 1000 and all(isinstance(value, exp.Literal) for value in item.expressions):
            out.append(finding(path, item, "MYSQL012", "ERROR", "literal IN list exceeds 1000 values"))
    for select in statement.find_all(exp.Select):
        joins = list(select.args.get("joins") or [])
        unqualified = any(isinstance(column, exp.Column) and not column.table for column in select.find_all(exp.Column))
        if len(joins) > 2 or (joins and unqualified):
            out.append(finding(path, select, "MYSQL013", "ERROR", "too many joined tables or unqualified multi-table columns"))
    for count in statement.find_all(exp.Count):
        if not isinstance(count.this, exp.Star):
            out.append(finding(path, count, "MYSQL104", "WARNING", "use COUNT(*) for row counts"))
    offset = statement.find(exp.Offset)
    if offset and isinstance(offset.expression, exp.Literal) and int(offset.expression.this) >= 10000:
        out.append(finding(path, offset, "MYSQL105", "WARNING", "large OFFSET requires pagination review"))
    if isinstance(statement, exp.Alter) and statement.find(exp.ForeignKey):
        out.append(finding(path, statement, "MYSQL015", "ERROR", "ALTER must not add a physical foreign key"))
    return out


def sanitize(source: str) -> str:
    return re.sub(r"'(?:''|\\.|[^'])*'|\"(?:\"\"|\\.|[^\"])*\"|--[^\n]*|/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n") + " ", source, flags=re.S)


def check_sql(path: Path, source: str) -> list[Finding]:
    clean = sanitize(source)
    try:
        statements = sqlglot.parse(source, read="mysql", error_level=sqlglot.ErrorLevel.RAISE)
    except ParseError as exc:
        return [Finding(path, 1, 1, "MYSQL000", "ERROR", f"cannot parse MySQL SQL: {exc}")]
    out: list[Finding] = []
    alters: dict[str, int] = {}
    for statement in statements:
        out.extend(check_statement(path, statement, clean))
        if isinstance(statement, exp.Alter) and (statement.args.get("kind") or "").upper() == "TABLE":
            alters[statement.this.name] = alters.get(statement.this.name, 0) + 1
    if any(count > 1 for count in alters.values()):
        out.append(Finding(path, 1, 1, "MYSQL014", "ERROR", "combine repeated ALTER TABLE statements"))
    if re.search(r"\bCHANGE\s+COLUMN\b|\bMODIFY\s+COLUMN\b", clean, re.I):
        out.append(Finding(path, 1, 1, "MYSQL103", "WARNING", "column change requires type and compatibility review"))
    if re.search(r"\bCREATE\s+(?:PROCEDURE|FUNCTION|TRIGGER)\b", clean, re.I) and not any(item.rule == "MYSQL007" for item in out):
        out.append(Finding(path, 1, 1, "MYSQL015", "ERROR", "stored routines and triggers are forbidden"))
    return sorted(set(out))


def discover(paths: Sequence[Path]) -> tuple[list[Path], list[Path]]:
    files, missing = [], []
    for path in paths:
        if path.is_file() and path.suffix.lower() == ".sql": files.append(path)
        elif path.is_dir(): files.extend(sorted(path.rglob("*.sql")))
        else: missing.append(path)
    return sorted(set(files)), missing


def apply_exceptions(findings: list[Finding], config: Path) -> list[Finding]:
    if not config.exists():
        return findings
    try:
        entries = tomllib.loads(config.read_text(encoding="utf-8")).get("exceptions", [])
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return [*findings, Finding(config, 1, 1, "MYSQL900", "ERROR", f"invalid exception config: {exc}")]
    remaining = list(findings)
    governance: list[Finding] = []
    required = {"rule", "path", "reason", "owner", "expires"}
    for index, entry in enumerate(entries, 1):
        error = None
        if not isinstance(entry, dict) or not required.issubset(entry):
            error = f"exception {index} requires rule, path, reason, owner, expires"
        else:
            rule, relative = entry["rule"], entry["path"]
            expiry = entry["expires"]
            try:
                expiry = date.fromisoformat(expiry) if isinstance(expiry, str) else expiry
            except ValueError:
                expiry = None
            if rule not in SUPPRESSIBLE:
                error = f"exception {index} has unknown rule {rule!r}"
            elif not all(isinstance(entry[key], str) and entry[key].strip() for key in ("path", "reason", "owner")):
                error = f"exception {index} has empty path, reason, or owner"
            elif not isinstance(expiry, date):
                error = f"exception {index} expires must be YYYY-MM-DD"
            elif expiry < date.today():
                error = f"exception {index} expired on {expiry}"
            else:
                target = (config.parent / relative).resolve()
                matches = [item for item in remaining if item.rule == rule and item.path.resolve() == target]
                if matches:
                    remaining = [item for item in remaining if item not in matches]
                else:
                    error = f"exception {index} is stale; no {rule} finding exists at {relative}"
        if error:
            governance.append(Finding(config, 1, 1, "MYSQL900", "ERROR", error))
    return [*remaining, *governance]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="*")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--changed-since")
    parser.add_argument("--project-root", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    requested = [Path(value) for value in args.paths]
    if args.changed_since:
        result = subprocess.run(
            ["git", "diff", "--name-only", "--diff-filter=ACMR", args.changed_since, "HEAD", "--", "*.sql"],
            cwd=args.project_root,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            print(f"error: cannot determine changed SQL files: {result.stderr.strip()}", file=sys.stderr)
            return 2
        requested.extend(args.project_root / line for line in result.stdout.splitlines() if line)
    if not requested and args.changed_since:
        print("MySQL quality check passed: no changed SQL files.")
        return 0
    if not requested:
        print("error: provide SQL paths or --changed-since", file=sys.stderr)
        return 2
    files, missing = discover(requested)
    if missing:
        print(f"error: path not found: {missing[0]}", file=sys.stderr)
        return 2
    findings = [item for path in files for item in check_sql(path, path.read_text(encoding="utf-8"))]
    config = args.config or (args.project_root / ".mysql-guard.toml")
    findings = apply_exceptions(findings, config)
    for item in sorted(findings): print(item.render())
    errors = sum(item.severity == "ERROR" for item in findings)
    warnings = sum(item.severity == "WARNING" for item in findings)
    if errors:
        print(f"MySQL quality check failed: {errors} error(s), {warnings} warning(s).")
        return 1
    print(f"MySQL quality check passed: {warnings} warning(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
