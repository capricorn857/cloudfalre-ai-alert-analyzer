# Infrastructure

## Apollo Configuration

- Store non-sensitive business configuration in Apollo namespaces named `{environment}-{module}`.
- Load initial configuration through FastAPI lifespan before accepting traffic.
- Run blocking Apollo clients in `asyncio.to_thread()` or a dedicated thread.
- Apply updates atomically and retain the last valid configuration after invalid updates or transient failures.
- Permit `.env` overrides only under an explicit local-development mode.
- Retrieve credentials and keys from encrypted configuration or the company secret service.

Each process and worker owns its lifecycle. Do not assume in-memory configuration is shared across Uvicorn workers.

## Lifespan And External I/O

Use FastAPI lifespan to initialize and close the SQLAlchemy engine, Redis client, Apollo watcher, and other process resources. Shutdown must cancel and await background watchers before closing dependencies.

Never call blocking database, HTTP, file, Redis, or Apollo clients directly from `async def`. Use a native async client when available. Isolate short unavoidable blocking work in a thread pool; move CPU-heavy or durable work to Celery.

Do not use bare `asyncio.create_task()` for work that must complete, retry, or be audited. Process-local tasks are limited to supervised infrastructure watchers with explicit cancellation and error handling.

## Celery

- Use Celery with Redis as broker; enable a result backend only when consumers need results.
- Names include service and module to prevent registration collisions.
- Pass scalar IDs and required context, never ORM objects, Session instances, connections, or coroutine objects.
- Durable tasks are idempotent and use `acks_late=True`, bounded retries, and backoff.
- Publish tasks that depend on new data only after the database transaction commits.
- Load and validate schedules from Apollo with a safe fallback.
- HTTP handlers do not execute report generation, bulk processing, large file parsing, or expected work over one second.

## Redis Cache-Aside

Use keys such as `{service}:{module}:{entity}:{id}`. Add a version segment when serialized schema compatibility changes.

- Suggested TTLs: hot data 5 minutes, ordinary data 30 minutes, cold data 2 hours; the feature spec may choose stricter values.
- Read cache, fall back to the source of truth, then populate JSON with a bounded TTL.
- Commit the database transaction before deleting affected cache keys.
- Retry or compensate failed invalidation when eventual invalidation is required.
- Add TTL jitter for hot keys and use short negative caching or a Bloom filter when penetration risk is demonstrated.
- Never cache passwords, access tokens, private keys, or equivalent secrets.
- Define degraded behavior for Redis outages; cache availability never defines data correctness.

Repository code does not read or write Redis. Service or a dedicated cache adapter coordinates cache behavior after transaction completion.

## Observability And Security

- Propagate or generate `trace_id` and include it in structured logs and error diagnostics.
- Record operation, duration, outcome, stable error code, and safe business identifiers.
- Do not log passwords, tokens, keys, connection strings, complete sensitive payloads, or raw dependency responses.
- Define metrics for request rate, latency, errors, pool usage, cache outcomes, Celery retries, queue delay, and dependency failures.
- Time out every external call. Retry only transient, idempotent operations with bounded attempts and backoff.

