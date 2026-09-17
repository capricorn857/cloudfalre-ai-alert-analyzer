# Execution Workflow

## Before Implementation

1. Resolve the exact change directory.
2. Read proposal, design, tasks, repository instructions, relevant code, and tests.
3. Run the workflow validator and `openspec validate <change-name> --strict` when available.
4. Confirm status is `approved` and artifacts agree.
5. Identify task dependencies, required tools, external approvals, and explicit checkpoints.

Do not implement `draft`, `reviewing`, missing-status, invalid, or ambiguous changes. Artifact completeness is not approval.

## Execute The Plan

Use `superpowers:subagent-driven-development` in the current session when independent tasks benefit from fresh implementers and review. Use `superpowers:executing-plans` for a separate execution session or sequential batch workflow.

An explicit request to implement or continue an approved change authorizes continuous execution of all ready tasks. Do not pause after each parent task.

Pause only when:

- `tasks.md` marks an explicit user or operational checkpoint;
- a destructive, irreversible, privileged, or production mutation requires authority;
- external coordination or credentials are unavailable;
- multiple active changes are ambiguous;
- requirements conflict or validation repeatedly fails without a safe resolution.

## TDD And Debugging

Use `superpowers:test-driven-development` for every behavior change: write the focused failing test, observe the expected failure, implement minimally, verify green, then refactor.

When encountering a bug, failing test, or unexpected behavior during execution, switch to `superpowers:systematic-debugging` before changing implementation.

## Task State

- Mark a child checkbox complete immediately after its implementation and verification succeed.
- Mark a parent complete only after every child and parent-level validation succeed.
- Keep blocked tasks unchecked and record the blocker rather than claiming partial completion.
- If implementation changes an approved design assumption, update the artifacts and obtain approval when the change is material before continuing.

Do not use task checkboxes as the only test evidence. Record commands and results in the execution report or the repository's established evidence location.

## Scope

Implement only the approved change. Do not mix unrelated cleanup or refactors into the task. Follow domain Skills and project instructions for architecture, security, database, frontend, and operational constraints.

