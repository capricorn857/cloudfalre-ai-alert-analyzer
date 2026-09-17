#!/usr/bin/env python3
"""Validate the team OpenSpec + Superpowers workflow contract."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


ALLOWED_STATUSES = {"draft", "reviewing", "approved", "implemented", "archived"}
REQUIRED_FILES = ("proposal.md", "design.md", "tasks.md")
REQUIRED_SECTIONS = {
    "proposal.md": ("背景", "目标", "非目标", "影响范围", "风险与兼容性", "验收标准"),
    "design.md": ("总体方案", "组件与边界", "数据与接口契约", "错误处理", "兼容与恢复", "测试计划"),
    "tasks.md": ("任务", "验证命令"),
}
CHANGE_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEADING = re.compile(r"^##\s+(.+?)\s*$")
CHECKBOX = re.compile(r"^\s*-\s+\[([ xX])\]\s+(\d+(?:\.\d+)*)(?:\.)?\s+(.+?)\s*$")
ANY_CHECKBOX = re.compile(r"^\s*-\s+\[[ xX]\]\s+")
PLACEHOLDER = re.compile(r"\b(?:TODO|TBD)\b|<(?:中文标题|change-name|topic|[^>]*placeholder[^>]*)>", re.I)


@dataclass(frozen=True, order=True)
class Finding:
    path: Path
    line: int
    rule: str
    message: str

    def render(self) -> str:
        return f"{self.path}:{self.line}: {self.rule} {self.message}"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def parse_status(path: Path, text: str) -> tuple[str | None, int, bool]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, 1, False
    try:
        end = next(index for index, line in enumerate(lines[1:], 1) if line.strip() == "---")
    except StopIteration:
        return None, 1, False
    status = None
    status_line = 1
    valid = True
    status_count = 0
    for index, line in enumerate(lines[1:end], 2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            valid = False
            continue
        key, value = (part.strip() for part in line.split(":", 1))
        if key == "status":
            status_count += 1
            status = value.strip("'\"")
            status_line = index
    return status, status_line, valid and status_count == 1


def sections(text: str) -> dict[str, tuple[int, str]]:
    lines = text.splitlines()
    starts: list[tuple[int, str]] = []
    for index, line in enumerate(lines, 1):
        match = HEADING.match(line)
        if match:
            starts.append((index, match.group(1).strip()))
    result: dict[str, tuple[int, str]] = {}
    for position, (line_number, title) in enumerate(starts):
        end = starts[position + 1][0] - 1 if position + 1 < len(starts) else len(lines)
        body = "\n".join(lines[line_number:end]).strip()
        result[title] = (line_number, body)
    return result


def scan_markdown(path: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    fence: str | None = None
    fence_line = 1
    for line_number, line in enumerate(text.splitlines(), 1):
        stripped = line.lstrip()
        marker = "```" if stripped.startswith("```") else "~~~" if stripped.startswith("~~~") else None
        if marker:
            if fence is None:
                fence, fence_line = marker, line_number
            elif marker == fence:
                fence = None
            continue
        if fence is None and PLACEHOLDER.search(line):
            findings.append(Finding(path, line_number, "OSWF007", "unresolved placeholder"))
    if fence is not None:
        findings.append(Finding(path, fence_line, "OSWF008", "unpaired Markdown code fence"))
    return findings


def validate_tasks(path: Path, text: str, status: str | None) -> list[Finding]:
    findings: list[Finding] = []
    identifiers: set[str] = set()
    task_states: dict[str, tuple[str, int]] = {}
    unchecked: list[int] = []
    checkbox_count = 0
    for line_number, line in enumerate(text.splitlines(), 1):
        if not ANY_CHECKBOX.match(line):
            continue
        checkbox_count += 1
        match = CHECKBOX.match(line)
        if not match:
            findings.append(Finding(path, line_number, "OSWF006", "checkbox task requires a numbered traceable id"))
            continue
        state, identifier, title = match.groups()
        if identifier in identifiers:
            findings.append(Finding(path, line_number, "OSWF006", f"duplicate task id {identifier}"))
        if "." in identifier and identifier.rsplit(".", 1)[0] not in identifiers:
            findings.append(Finding(path, line_number, "OSWF006", f"task {identifier} has no parent task"))
        if not title.strip():
            findings.append(Finding(path, line_number, "OSWF006", f"task {identifier} requires a title"))
        identifiers.add(identifier)
        task_states[identifier] = (state, line_number)
        if state == " ":
            unchecked.append(line_number)
    for identifier, (state, line_number) in task_states.items():
        if state != " ":
            continue
        parts = identifier.split(".")
        ancestors = [".".join(parts[:index]) for index in range(1, len(parts))]
        if any(task_states.get(ancestor, (" ", 0))[0].lower() == "x" for ancestor in ancestors):
            findings.append(Finding(path, line_number, "OSWF006", f"open task {identifier} has a completed parent"))
    if status in {"approved", "implemented", "archived"} and checkbox_count == 0:
        findings.append(Finding(path, 1, "OSWF004", "approved-or-later tasks.md requires checkbox tasks"))
    if status in {"implemented", "archived"}:
        findings.extend(Finding(path, line, "OSWF005", "implemented change contains an unchecked task") for line in unchecked)
    return findings


def validate_change(change_dir: Path) -> list[Finding]:
    findings: list[Finding] = []
    if not CHANGE_NAME.fullmatch(change_dir.name):
        findings.append(Finding(change_dir, 1, "OSWF001", "change name must use English kebab-case"))

    artifacts: dict[str, str] = {}
    for filename in REQUIRED_FILES:
        path = change_dir / filename
        if not path.is_file():
            findings.append(Finding(path, 1, "OSWF002", f"missing required artifact {filename}"))
            continue
        try:
            artifacts[filename] = read(path)
        except (OSError, UnicodeError) as exc:
            findings.append(Finding(path, 1, "OSWF002", f"cannot read artifact: {exc}"))

    proposal = artifacts.get("proposal.md", "")
    status, status_line, frontmatter_valid = parse_status(change_dir / "proposal.md", proposal)
    if not frontmatter_valid or status not in ALLOWED_STATUSES:
        findings.append(Finding(change_dir / "proposal.md", status_line, "OSWF003", "proposal requires valid workflow status frontmatter"))

    for filename, text in artifacts.items():
        path = change_dir / filename
        findings.extend(scan_markdown(path, text))
        if status in {"approved", "implemented", "archived"}:
            found_sections = sections(text)
            for title in REQUIRED_SECTIONS[filename]:
                entry = found_sections.get(title)
                if entry is None or not entry[1].strip():
                    findings.append(Finding(path, entry[0] if entry else 1, "OSWF004", f"missing meaningful section: {title}"))

    if "tasks.md" in artifacts:
        findings.extend(validate_tasks(change_dir / "tasks.md", artifacts["tasks.md"], status))

    if status == "archived" and "changes" in change_dir.parts:
        findings.append(Finding(change_dir / "proposal.md", status_line, "OSWF009", "archived change must not remain in active changes directory"))
    return sorted(findings)


def discover_changes(path: Path) -> list[Path] | None:
    if not path.is_dir():
        return None
    if any((path / filename).exists() for filename in REQUIRED_FILES) or path.parent.name == "changes":
        return [path]
    changes = path / "changes" if (path / "changes").is_dir() else path if path.name == "changes" else None
    if changes is None:
        return None
    return sorted(item for item in changes.iterdir() if item.is_dir())


def validate_path(path: Path) -> list[Finding]:
    changes = discover_changes(path)
    if changes is None:
        raise ValueError(f"not an OpenSpec root or change directory: {path}")
    return sorted(finding for change in changes for finding in validate_change(change))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="OpenSpec root, changes directory, or change directory")
    args = parser.parse_args(argv)
    path = Path(args.path).resolve()
    try:
        findings = validate_path(path)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for item in findings:
        print(item.render())
    if findings:
        print(f"OpenSpec workflow validation failed: {len(findings)} finding(s).")
        return 1
    print("OpenSpec workflow validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
