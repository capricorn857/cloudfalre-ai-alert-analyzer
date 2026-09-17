---
name: openspec-superpowers-workflow
description: Use when creating, reviewing, approving, implementing, continuing, validating, syncing, or archiving an OpenSpec change, or when deciding whether a requested feature, bug fix, refactor, schema change, or production-impacting task requires a formal change workflow.
---

# OpenSpec + Superpowers Workflow

## Core Contract

OpenSpec is the single source of truth. Superpowers provides the reasoning and execution process. For a formal change, write only:

```text
openspec/changes/<change-name>/
├── proposal.md
├── design.md
└── tasks.md
```

Do not create parallel design or plan files under `docs/superpowers`. Treat the OpenSpec paths as the user-selected output locations when using `brainstorming` and `writing-plans`.

The user's explicit instructions take precedence. Do not infer approval, production authority, sync, or archive permission.

## Load Guidance

- Read [change-routing.md](references/change-routing.md) before deciding whether formal artifacts are required.
- Read [artifact-contracts.md](references/artifact-contracts.md) when creating or reviewing proposal, design, or tasks.
- Read [execution-workflow.md](references/execution-workflow.md) before implementing or continuing a change.
- Read [validation-and-archive.md](references/validation-and-archive.md) before status transitions, sync, archive, or completion claims.

## State Gate

```text
draft -> reviewing -> approved -> implemented -> archived
```

- `draft` and `reviewing`: implementation is forbidden.
- `approved`: implementation is allowed when all artifacts validate.
- `implemented`: every task and required check is complete.
- `archived`: only after explicit user direction.

Missing, invalid, or ambiguous status blocks implementation. Explicit user approval is required to enter `approved`; implementation completion does not authorize archive.

## Superpowers Mapping

| Need | Required Skill | Canonical output |
|---|---|---|
| Feature/behavior design | `superpowers:brainstorming` | `proposal.md`, `design.md` |
| Bug diagnosis | `superpowers:systematic-debugging` | Evidence used by design/tasks |
| Planning | `superpowers:writing-plans` | `tasks.md` |
| Implementation | `superpowers:test-driven-development` | Code and test evidence |
| Plan execution | `superpowers:subagent-driven-development` or `superpowers:executing-plans` | Task checkboxes |
| Completion | `superpowers:verification-before-completion` | Fresh validation evidence |
| Integration | `superpowers:finishing-a-development-branch` | User-selected branch outcome |

## Workflow Gate

Before implementation, run:

```bash
python <skill-dir>/scripts/validate_openspec_workflow.py openspec/changes/<change-name>
```

After approval, an implement/continue request authorizes all ready tasks to run continuously. Pause only at an explicit checkpoint, destructive or production action, external dependency, ambiguous change, or unresolved conflict. Update checkboxes as tasks finish; do not mark `implemented` until fresh verification passes.

