#!/usr/bin/env python3
"""Fail-closed architecture checks for team FastAPI projects."""

from __future__ import annotations

import argparse
import ast
import re
import sys
import tomllib
from dataclasses import dataclass
from datetime import date
from pathlib import Path


IGNORED_DIRECTORIES = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "tests",
    "venv",
}
HTTP_METHODS = {"delete", "get", "head", "options", "patch", "post", "put"}
SESSION_OPERATIONS = {
    "add",
    "add_all",
    "commit",
    "delete",
    "execute",
    "flush",
    "get",
    "refresh",
    "rollback",
    "scalar",
    "scalars",
}
SUPPRESSIBLE_RULES = {f"FAPI00{number}" for number in range(2, 8)}


@dataclass(frozen=True, order=True)
class Violation:
    path: Path
    line: int
    column: int
    rule: str
    message: str

    def render(self, root: Path) -> str:
        try:
            display_path = self.path.relative_to(root)
        except ValueError:
            display_path = self.path
        return (
            f"{display_path}:{self.line}:{self.column}: "
            f"{self.rule} {self.message}"
        )


def annotation_mentions_async_session(annotation: ast.expr | None) -> bool:
    if annotation is None:
        return False
    return any(
        isinstance(node, ast.Name) and node.id == "AsyncSession"
        or isinstance(node, ast.Attribute) and node.attr == "AsyncSession"
        for node in ast.walk(annotation)
    )


def is_repository_file(path: Path) -> bool:
    return (
        "repositories" in path.parts
        or "repository" in path.parts
        or path.stem.endswith("_repository")
    )


def is_router_file(path: Path) -> bool:
    return (
        "routers" in path.parts
        or path.stem in {"router", "routes"}
        or path.stem.endswith("_router")
    )


class ArchitectureVisitor(ast.NodeVisitor):
    def __init__(self, path: Path, *, repository: bool, router: bool) -> None:
        self.path = path
        self.repository = repository
        self.router = router
        self.foreign_key_names = {"ForeignKey"}
        self.session_names = {"session", "db_session"}
        self.violations: list[Violation] = []

    def add(self, node: ast.AST, rule: str, message: str) -> None:
        self.violations.append(
            Violation(
                self.path,
                getattr(node, "lineno", 1),
                getattr(node, "col_offset", 0) + 1,
                rule,
                message,
            )
        )

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        for alias in node.names:
            if module == "sqlalchemy" and alias.name == "ForeignKey":
                self.foreign_key_names.add(alias.asname or alias.name)
        if self.router and {"repository", "repositories"}.intersection(module.split(".")):
            self.add(node, "FAPI004", "Router must depend on Service, not Repository.")
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        if self.router:
            for alias in node.names:
                if {"repository", "repositories"}.intersection(alias.name.split(".")):
                    self.add(node, "FAPI004", "Router must depend on Service, not Repository.")
                    break
        self.generic_visit(node)

    def _record_session_arguments(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        for argument in arguments:
            if annotation_mentions_async_session(argument.annotation):
                self.session_names.add(argument.arg)

    def _check_route_decorators(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if not self.router:
            return
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                continue
            if decorator.func.attr not in HTTP_METHODS:
                continue
            response_model = next(
                (keyword.value for keyword in decorator.keywords if keyword.arg == "response_model"),
                None,
            )
            if response_model is None or (
                isinstance(response_model, ast.Constant) and response_model.value is None
            ):
                self.add(
                    decorator,
                    "FAPI006",
                    "HTTP route decorator must declare an enabled response_model.",
                )

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._record_session_arguments(node)
        self._check_route_decorators(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._record_session_arguments(node)
        self._check_route_decorators(node)
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if isinstance(node.target, ast.Name) and annotation_mentions_async_session(node.annotation):
            self.session_names.add(node.target.id)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        if isinstance(node.func, ast.Name) and node.func.id in self.foreign_key_names:
            self.add(node, "FAPI001", "Physical ForeignKey constraints are forbidden.")
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "ForeignKey":
            self.add(node, "FAPI001", "Physical ForeignKey constraints are forbidden.")

        if isinstance(node.func, ast.Attribute):
            operation = node.func.attr
            if self.repository and operation == "commit":
                self.add(node, "FAPI002", "Repository must not commit; Service owns transactions.")
            elif self.repository and operation == "rollback":
                self.add(node, "FAPI003", "Repository must not rollback; Service owns transactions.")

            if (
                self.router
                and operation in SESSION_OPERATIONS
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in self.session_names
            ):
                self.add(node, "FAPI005", "Router must not perform AsyncSession data operations.")
        self.generic_visit(node)


def iter_python_files(root: Path):
    for path in root.rglob("*.py"):
        relative_parts = path.relative_to(root).parts
        if any(part in IGNORED_DIRECTORIES for part in relative_parts[:-1]):
            continue
        yield path


def check_python_file(root: Path, path: Path) -> list[Violation]:
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, UnicodeError, SyntaxError) as exc:
        line = exc.lineno if isinstance(exc, SyntaxError) and exc.lineno else 1
        column = exc.offset if isinstance(exc, SyntaxError) and exc.offset else 1
        return [Violation(path, line, column, "FAPI000", f"Cannot parse Python file: {exc}")]

    relative = path.relative_to(root)
    visitor = ArchitectureVisitor(
        path,
        repository=is_repository_file(relative),
        router=is_router_file(relative),
    )
    visitor.visit(tree)
    return visitor.violations


def python_floor_is_312_or_newer(specifier: str) -> bool:
    match = re.search(r"(?:>=|~=|==|\^)\s*(\d+)\.(\d+)", specifier)
    if match is None:
        return False
    return (int(match.group(1)), int(match.group(2))) >= (3, 12)


def check_python_version(root: Path) -> list[Violation]:
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return [
            Violation(
                pyproject,
                1,
                1,
                "FAPI007",
                'pyproject.toml must set requires-python = ">=3.12".',
            )
        ]
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        return [Violation(pyproject, 1, 1, "FAPI007", f"Cannot read Python version: {exc}")]

    specifier = data.get("project", {}).get("requires-python")
    if specifier is None:
        specifier = data.get("tool", {}).get("poetry", {}).get("dependencies", {}).get("python")
    if not isinstance(specifier, str) or not python_floor_is_312_or_newer(specifier):
        return [
            Violation(
                pyproject,
                1,
                1,
                "FAPI007",
                "Project must require Python 3.12 or newer.",
            )
        ]
    return []


def apply_configured_exceptions(
    root: Path, violations: list[Violation]
) -> list[Violation]:
    pyproject = root / "pyproject.toml"
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        return violations

    configured = data.get("tool", {}).get("fastapi-guard", {}).get("exceptions", [])
    if not isinstance(configured, list):
        return [
            *violations,
            Violation(
                pyproject,
                1,
                1,
                "FAPI008",
                "tool.fastapi-guard.exceptions must be an array of tables.",
            ),
        ]

    remaining = list(violations)
    governance_violations: list[Violation] = []
    required_fields = {"rule", "path", "reason", "owner", "expires"}
    for index, exception in enumerate(configured, start=1):
        label = f"Exception {index}"
        if not isinstance(exception, dict) or not required_fields.issubset(exception):
            governance_violations.append(
                Violation(
                    pyproject,
                    1,
                    1,
                    "FAPI008",
                    f"{label} requires rule, path, reason, owner, and expires.",
                )
            )
            continue

        rule = exception["rule"]
        relative_path = exception["path"]
        reason = exception["reason"]
        owner = exception["owner"]
        expires = exception["expires"]
        try:
            expiry_date = date.fromisoformat(expires)
        except (TypeError, ValueError):
            expiry_date = None

        error = None
        if rule not in SUPPRESSIBLE_RULES:
            error = f"{label} has unknown or non-suppressible rule {rule!r}."
        elif not isinstance(relative_path, str) or not relative_path.strip():
            error = f"{label} requires a non-empty path."
        elif not isinstance(reason, str) or not reason.strip():
            error = f"{label} requires a non-empty reason."
        elif not isinstance(owner, str) or not owner.strip():
            error = f"{label} requires a non-empty owner."
        elif expiry_date is None:
            error = f"{label} expires must use YYYY-MM-DD."
        elif expiry_date < date.today():
            error = f"{label} expired on {expiry_date.isoformat()}."

        if error:
            governance_violations.append(
                Violation(pyproject, 1, 1, "FAPI008", error)
            )
            continue

        matches = [
            violation
            for violation in remaining
            if violation.rule == rule
            and violation.path.relative_to(root).as_posix() == relative_path
        ]
        if not matches:
            governance_violations.append(
                Violation(
                    pyproject,
                    1,
                    1,
                    "FAPI008",
                    f"{label} is stale; no {rule} violation exists at {relative_path}.",
                )
            )
            continue
        remaining = [violation for violation in remaining if violation not in matches]

    return [*remaining, *governance_violations]


def check_project(root: Path) -> list[Violation]:
    violations = check_python_version(root)
    for path in iter_python_files(root):
        violations.extend(check_python_file(root, path))
    return sorted(apply_configured_exceptions(root, violations))


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default=".", help="FastAPI project root")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"error: project root is not a directory: {root}", file=sys.stderr)
        return 2

    violations = check_project(root)
    if violations:
        for violation in violations:
            print(violation.render(root))
        print(f"FastAPI architecture check failed: {len(violations)} violation(s).")
        return 1

    print("FastAPI architecture check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
