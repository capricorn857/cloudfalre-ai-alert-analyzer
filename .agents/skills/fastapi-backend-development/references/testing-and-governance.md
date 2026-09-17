# Testing And Governance

## TDD Requirement

Service business rules, Repository data access, and Schema validation use Red-Green-Refactor:

1. Write one focused test for the required behavior.
2. Run it and confirm it fails because the behavior is missing.
3. Implement the minimum behavior that passes.
4. Run focused and related tests.
5. Refactor only while the suite remains green.

Tests added after implementation do not demonstrate TDD. A deadline, small change, manual test, existing untested code, or green CI does not waive the rule.

## Test Layers

| Layer | Coverage |
|---|---|
| Unit | Service rules, transformations, Schema validation, utilities |
| Integration | Repository and Service with MySQL/Redis boundaries |
| API | Router, dependencies, authentication, errors, pagination, unified responses |

- Service and Repository coverage must be at least 80%.
- Use HTTPX `AsyncClient` with `ASGITransport`; use `LifespanManager` when the application relies on lifespan.
- Isolate database state per test and never connect tests to shared development or production data.
- Test success, validation, authentication, authorization, not-found, conflict, pagination boundaries, and dependency failures.
- Test concurrency, uniqueness, locks, MySQL SQL, and isolation semantics on MySQL.
- Every feature scenario in a spec must trace to at least one test.

## Required Spec Content

Each FastAPI feature spec defines:

- method, path, request schema, response schema, and HTTP statuses;
- data fields, indexes, logical associations, and deletion policy;
- registered business errors;
- transaction boundary and participating Repositories;
- async versus blocking I/O boundaries;
- Celery task name, queue, arguments, idempotency, retry, and publication timing;
- cache key, TTL, invalidation, consistency, and degradation;
- authentication, authorization, data scope, logs, traces, and metrics.

## Completion Gate

Before claiming completion:

1. Run focused tests and observe zero failures.
2. Run `python <skill-dir>/scripts/check_fastapi_architecture.py <project-root>`.
3. Run the project test suite and Ruff checks.
4. Review migrations, OpenAPI, error codes, async boundaries, and operational impact.
5. Report any check that could not be run; do not imply enforcement that did not occur.

Every `FAPI` violation is blocking. Existing code is not an exemption. Fix the violation or use a formally recorded, temporary exception.

| Rule | Violation |
|---|---|
| `FAPI000` | Python source cannot be parsed; this rule cannot be suppressed |
| `FAPI001` | Physical SQLAlchemy `ForeignKey`; this rule cannot be suppressed |
| `FAPI002` | Repository calls `commit()` |
| `FAPI003` | Repository calls `rollback()` |
| `FAPI004` | Router imports Repository |
| `FAPI005` | Router performs direct Session data access |
| `FAPI006` | HTTP route omits `response_model` |
| `FAPI007` | Missing or lower-than-3.12 Python requirement |
| `FAPI008` | Invalid, expired, unknown, or stale exception; this rule cannot be suppressed |

## Temporary Exceptions

Exceptions belong in `pyproject.toml` and must be precise and time-limited:

```toml
[[tool.fastapi-guard.exceptions]]
rule = "FAPI006"
path = "app/api/routers/legacy.py"
reason = "Legacy response contract migration"
owner = "backend-team"
expires = "2026-12-31"
```

The gate rejects unknown or non-suppressible rules, missing metadata, invalid dates, expired exceptions, and stale exceptions whose violation no longer exists. `FAPI001` is non-suppressible. Never add a broad path, permanent expiry, inline suppression, or `allow_failure` to avoid remediation.

## Review And Versioning

- Rule changes require an Issue, impact statement, review, and migration guidance.
- MAJOR removes or redefines a principle; MINOR adds or expands rules; PATCH clarifies without changing behavior.
- Publish immutable tags and let target projects pin a reviewed version.
- Pilot new blocking rules against representative projects and measure false positives before team-wide rollout.
- A target repository enforces the standard only when its protected-branch CI invokes the checker and requires success.
