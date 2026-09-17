# Operations README Design

## Purpose

Create a root-level `README.md` for operations engineers deploying and maintaining Cloudflare AI Alert Analyzer. GitHub should render it as the repository entry point. It must summarize the system without duplicating the detailed product requirements, technical design, deployment guide, or release checklist.

## Audience

The primary audience is an operations or security engineer who needs to:

- understand what the Worker does and does not do;
- prepare Cloudflare resources and credentials;
- connect the GitHub repository to Workers Builds;
- configure runtime variables and secrets in the correct location;
- deploy and verify the webhook-to-Queue-to-WeCom flow;
- diagnose common deployment failures and roll back safely.

## Content Structure

The README will use this order:

1. Project summary and MVP scope.
2. Compact text diagram of the processing flow.
3. Read-only, single-snapshot, and at-least-once operational boundaries.
4. Prerequisites and required Cloudflare resources.
5. Repository setup and local verification commands.
6. GitHub-to-Workers Builds configuration.
7. Runtime Secrets, Text variables, Wrangler-managed configuration, and Queue binding.
8. First deployment sequence.
9. Webhook endpoint and Cloudflare Security Events notification connection.
10. Post-deployment verification and log checks.
11. Common commands and troubleshooting.
12. Rollback guidance and links to authoritative repository documents.

## Configuration Rules

The README will explicitly distinguish:

- the Workers Builds deployment token selected in Build Configuration;
- the runtime `CLOUDFLARE_API_TOKEN` used only for read-only GraphQL Analytics queries;
- build-time variables, which this project does not require;
- runtime Secrets (`CLOUDFLARE_API_TOKEN`, `LLM_API_KEY`, `WECOM_WEBHOOK_URL`);
- runtime Text variables (`LLM_BASE_URL`, `LLM_MODEL`);
- `BUSINESS_CONFIG`, which is maintained in `wrangler.jsonc`;
- `ALERT_QUEUE`, which is a Queue binding rather than a text variable.

All examples will use placeholders. No credential-shaped example value, real account identifier, zone identifier, webhook key, API key, or token will be included.

## Deployment Guidance

The documented Workers Builds configuration will match the repository:

```text
Worker name: cloudflare-ai-alert-analyzer
Production branch: master (or the repository's selected production branch)
Root directory: /
Build command: npm run types && npm run typecheck && npm run lint
Deploy command: npm run deploy
```

The README will state that tests must be run locally when `test/` is not present in the GitHub deployment repository. It will also document these observed Cloudflare failure modes:

- a deleted or rolled build token must be replaced in Build Configuration;
- an initial `seed_repo` build cannot be retried and requires a new commit or another new build trigger;
- runtime credentials must not be entered as build variables;
- `CLOUDFLARE_API_TOKEN` as a build variable can interfere with Wrangler deployment authentication.

## Operational Safety

The README will preserve these project constraints:

- no production deployment or Cloudflare resource mutation is implied by the document;
- the Worker is read-only and never changes WAF configuration;
- Queue delivery is at least once, so duplicate notifications remain possible;
- retries reuse the fixed analysis window;
- LLM failure falls back to deterministic analysis;
- credentials must remain in Workers Secrets and out of Git, logs, fixtures, and documentation;
- the public MVP webhook currently has no inbound authentication and requires explicit risk acceptance before production use.

## Validation

After creating `README.md`:

1. Check every command and configuration name against `package.json`, `wrangler.jsonc`, and `src/config/env.ts`.
2. Check links to repository documents and headings.
3. Scan for unfinished markers and credential-like values.
4. Run Markdown-focused inspection and the project's non-behavioral checks as appropriate.
5. Confirm that no source, runtime configuration, generated binding, or historical backup document changed.
