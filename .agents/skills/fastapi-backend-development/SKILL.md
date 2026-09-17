---
name: fastapi-backend-development
description: Use when creating, modifying, reviewing, or testing FastAPI backend services that use Python, Pydantic, SQLAlchemy, MySQL, Redis, Celery, Apollo, API contracts, repositories, or SQL migrations.
---

# FastAPI Backend Development

## Purpose

Apply the team's FastAPI standard to implementation and review. The core boundary is `Router -> Schema -> Service -> Repository -> Model`; Python 3.12, logical foreign keys, Service-owned transactions, explicit API contracts, and the automated gate are mandatory.

The user's explicit instructions take precedence. When a request conflicts with a mandatory team rule, identify the conflict instead of silently weakening the rule.

## Load Relevant Guidance

- Always read [architecture-and-api.md](references/architecture-and-api.md) for endpoint, schema, service, or review work.
- Read [database-and-migrations.md](references/database-and-migrations.md) for Model, Repository, transaction, query, index, or migration work.
- Read [infrastructure.md](references/infrastructure.md) for Apollo, Redis, Celery, lifespan, external I/O, logging, or tracing work.
- Read [testing-and-governance.md](references/testing-and-governance.md) for implementation, tests, specs, plans, reviews, and release decisions.
- Read [ci-integration.md](references/ci-integration.md) when installing or changing the mandatory gate.

## Workflow

1. Inspect the target repository and read the references relevant to the task.
2. State affected layers, API contracts, transaction boundary, async boundary, and migration impact before implementation.
3. Write a failing test for each behavior change, confirm the expected failure, implement minimally, then refactor while green.
4. Preserve the five-layer dependency direction. Existing violations are not precedents.
5. Run focused tests, the architecture checker, and the project test suite before completion.

Resolve this skill's directory and run:

```bash
python <skill-dir>/scripts/check_fastapi_architecture.py <project-root>
```

Any reported `FAPI` violation blocks completion and merge. Do not bypass the gate because a deadline is close, existing code uses the pattern, tests pass, or the change is small. A temporary exception is valid only when `pyproject.toml` records an exact rule and path plus a non-empty reason, owner, and unexpired date.

Physical foreign keys (`FAPI001`) cannot be suppressed.

## Non-Negotiable Rules

| Rule | Required outcome |
|---|---|
| Python | `requires-python` has a 3.12+ floor |
| Data model | No SQLAlchemy or database `ForeignKey` |
| Transactions | Service owns begin/commit/rollback |
| Repository | Data access only; `flush()` is allowed |
| Router | Depends on Service, never Repository or direct Session I/O |
| API | Every HTTP route declares `response_model` and unified errors |
| Migrations | Applied SQL files are immutable; fixes use new migrations |
| Async work | Blocking or durable work is isolated or sent to Celery |

## Common Mistakes

- Treating green tests as permission to violate architecture.
- Adding `ForeignKey` because it is normal SQLAlchemy practice.
- Calling `commit()` in Repository methods for convenience.
- Returning raw dictionaries without an explicit response schema.
- Editing an applied migration instead of adding a forward correction.
- Claiming the gate is enforced when the target CI does not invoke it.
