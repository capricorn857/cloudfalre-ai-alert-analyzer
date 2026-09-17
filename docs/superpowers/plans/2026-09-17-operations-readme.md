# Operations README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-level Chinese `README.md` that lets operations engineers configure, deploy, verify, troubleshoot, and roll back Cloudflare AI Alert Analyzer safely.

**Architecture:** The README is a concise operational entry point backed by the existing requirements, technical stack, deployment guide, and release checklist. It documents the deployed data flow and configuration ownership without duplicating detailed specifications or changing application behavior.

**Tech Stack:** Markdown, Cloudflare Workers, Cloudflare Queues, Workers Builds, Wrangler, npm

## Global Constraints

- Create the standard GitHub entry-point file `README.md`, not `READ.md`.
- Write for operations and security engineers in Chinese.
- Do not modify source code, runtime configuration, generated bindings, tests, or the historical requirements backup.
- Do not include real credentials, account identifiers, zone identifiers, webhook keys, or credential-shaped example values.
- Keep the system read-only and describe Queue delivery as at least once rather than exactly once.
- Treat `docs/Cloudflare AI 告警分析系统需求文档.md`, `docs/Cloudflare AI 告警分析系统技术栈.md`, and the approved OpenSpec change as authoritative.

---

### Task 1: Create And Validate The Operations README

**Files:**
- Create: `README.md`
- Reference: `package.json`
- Reference: `wrangler.jsonc`
- Reference: `src/config/env.ts`
- Reference: `docs/deployment-verification.md`
- Reference: `docs/release-checklist.md`

**Interfaces:**
- Consumes: npm script names, Worker and Queue names, bindings, runtime configuration keys, webhook route, and documented operational constraints.
- Produces: a GitHub-rendered operations guide; no runtime interface or application behavior changes.

- [x] **Step 1: Create the README with the approved operational structure**

Create `README.md` with these headings in this order:

```markdown
# Cloudflare AI Alert Analyzer
## 项目简介
## 处理流程
## 运行边界
## 前置条件
## Cloudflare 资源
## 本地验证
## Workers Builds
## 运行时配置
## 首次部署
## Webhook 接入
## 部署后验证
## 常用命令
## 故障排查
## 回滚
## 相关文档
```

Describe the exact Worker and Queue name `cloudflare-ai-alert-analyzer`, webhook route `POST /api/v1/alerts/cloudflare`, Build command `npm run types && npm run typecheck && npm run lint`, and Deploy command `npm run deploy`. Include the three runtime Secrets, two runtime Text variables, Wrangler-managed `BUSINESS_CONFIG`, and Queue binding `ALERT_QUEUE` in a configuration table.

- [x] **Step 2: Add deployment safety and troubleshooting guidance**

Document these operational facts explicitly:

```text
Build Token and runtime CLOUDFLARE_API_TOKEN are separate credentials.
This project requires no Workers Builds environment variables.
Runtime credentials belong in Worker Settings > Variables and Secrets.
A deleted or rolled Build Token must be replaced in Build Configuration.
An initial seed_repo build cannot be retried; a new production-branch commit triggers a normal build.
LLM failure produces a deterministic fallback notification.
Queue delivery is at least once and can produce duplicate notifications.
The MVP webhook has no inbound authentication and must not be protected by Cloudflare Access if Cloudflare Notifications must call it.
```

Link to `docs/deployment-verification.md`, `docs/release-checklist.md`, the requirements document, the technical stack document, and the active OpenSpec change.

- [x] **Step 3: Validate names, links, formatting, and credential safety**

Run:

```bash
test -f README.md
rg -n "cloudflare-ai-alert-analyzer|ALERT_QUEUE|CLOUDFLARE_API_TOKEN|LLM_API_KEY|WECOM_WEBHOOK_URL|LLM_BASE_URL|LLM_MODEL|BUSINESS_CONFIG|/api/v1/alerts/cloudflare" README.md
rg -n "sk-[A-Za-z0-9_-]{16,}|Bearer[[:space:]]+[A-Za-z0-9._-]{16,}|qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=[A-Za-z0-9-]{12,}" README.md
git diff --check
git status --short
```

Expected:

```text
README.md exists.
All required operational names appear.
The credential scan returns no matches.
git diff --check returns no output and exits successfully.
Only README.md and this plan are new relative to the approved design commit.
```

- [x] **Step 4: Review the rendered content against the approved design**

Confirm manually that:

```text
The first screen identifies the product and its read-only purpose.
Deployment steps are ordered from resource creation through post-deployment verification.
Build variables and runtime variables cannot be confused.
No statement claims exactly-once delivery or automatic WAF modification.
Detailed material is linked rather than copied wholesale.
```

- [x] **Step 5: Commit the README**

```bash
git add README.md docs/superpowers/plans/2026-09-17-operations-readme.md
git commit -m "docs: add operations README"
```
