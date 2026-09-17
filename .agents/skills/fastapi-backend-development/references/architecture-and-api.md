# Architecture And API

## Technology Baseline

- Python 3.12+
- FastAPI 0.115+
- Pydantic 2.x and pydantic-settings 2.x
- SQLAlchemy 2.x asynchronous API
- MySQL 8.0+, Redis 7.x, Celery 5.x
- Pytest, AnyIO or pytest-asyncio, HTTPX, Factory Boy, Ruff, uv

Pin exact compatible versions in `uv.lock`; do not specify `latest` as a reproducibility policy.

## Five-Layer Boundary

| Layer | Responsibility | Must not |
|---|---|---|
| Router | HTTP input/output, authentication dependencies, call Service | Query database, import Repository, own transactions |
| Schema | Validate request, response, and internal DTO data | Perform I/O or business side effects |
| Service | Business rules, transaction boundary, Repository orchestration | Depend on Request or Response |
| Repository | SQLAlchemy statements and persistence | Commit, rollback, return HTTP responses |
| Model | Table columns and indexes | Contain business logic, physical foreign keys, implicit I/O |

Dependencies move only from left to right. Cross-module code calls the other module's public Service, not its Repository.

Use separate request, response, and internal schemas where their contracts differ. Pydantic output from ORM objects uses `ConfigDict(from_attributes=True)` and `model_validate()`.

## Dependency Injection

- Create one `AsyncSession` per request with a yield dependency.
- Construct Services explicitly through `Depends` or a project dependency provider.
- Do not retrieve sessions, repositories, Redis, or configuration from mutable module globals.
- Store process-lifetime clients in lifespan state and expose them through typed dependencies.

## API Contract

All business responses use:

```json
{"code": 0, "data": {}, "message": "success"}
```

Errors use the same shape with `data: null`. Pagination data contains `items`, `total`, `page`, `page_size`, and `total_pages`.

Each route must:

- use the `/api/` prefix and RESTful resource naming;
- declare `response_model`;
- declare the correct success HTTP status;
- expose documented request, response, authentication, and error contracts;
- avoid returning ORM instances through an unbounded response type.

HTTP status mapping:

| Status | Meaning |
|---|---|
| 200 | Query or update success |
| 201 | Create success |
| 400 | Business input error |
| 401 | Missing or invalid authentication |
| 403 | Authenticated but forbidden |
| 404 | Resource not found |
| 409 | Uniqueness or state conflict |
| 422 | Pydantic request validation failure |
| 500 | Unhandled server error |

## Error Codes

Use registered five-digit codes, never bare numbers scattered through Routers or Services:

| Range | Domain |
|---|---|
| 10000-19999 | Common and protocol errors |
| 20000-29999 | User and authentication |
| 30000-39999 | Authorization |
| 40000-49999 | Business domain |
| 50000-59999 | System and dependencies |

Global exception handlers convert business exceptions, request validation, authentication, authorization, HTTP exceptions, and unknown exceptions to the unified shape. Unknown exceptions return code `10001`; log the full internal error with `trace_id` but never expose stack traces, SQL, credentials, internal hosts, or raw third-party responses.

OpenAPI is part of the contract. Endpoint, schema, status, or authentication changes require an OpenAPI update and contract test.

