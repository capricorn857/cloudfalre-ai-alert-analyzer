# AGENTS.md

## 项目定位

Cloudflare AI Alert Analyzer 是运行于 Cloudflare Workers 的 WAF 告警分析系统。

- 接收告警，执行一次固定窗口的快照分析，并发送企业微信通知。
- 只读，不自动修改 Cloudflare 配置。
- 不持续跟踪后续事件，不建设 Web 后台、权限或历史检索。
- 使用 Cloudflare Queues，不使用自建服务器、容器或数据库。

## 规范来源与优先级

实施前阅读：

- `docs/Cloudflare AI 告警分析系统需求文档.md`
- `docs/Cloudflare AI 告警分析系统技术栈.md`
- 当前任务对应的 `openspec/changes/<change-name>/`

优先级：用户明确指令 > 已确认 OpenSpec > 需求和技术文档 > 本文件 > 局部代码惯例。冲突时先说明，不得静默选择。

`docs/Cloudflare AI 告警分析系统需求文档-v0.1-2026-09-16备份.md` 是历史备份，除非用户明确要求，不得修改。

## 当前仓库状态

- 仓库已初始化 Git 和 OpenSpec。
- 当前没有正式 OpenSpec Change、Worker 工程或生产代码。
- 文档中的目录和命令是目标约定，不代表已经存在。
- 首次 MVP 实现必须先完成并确认 OpenSpec。

## 核心技术栈

使用 TypeScript、Cloudflare Workers、Cloudflare Queues、Fetch API、Zod、Wrangler、Vitest、ESLint 和 npm。

未经确认不得引入 Python/FastAPI、HTTP 框架、D1、KV、Durable Objects、R2、Workflows、数据库、第三方队列、容器或新的 LLM SDK。

## 目标工程结构

```text
src/
├── index.ts
├── api/
├── analyzers/
├── clients/
├── config/
├── domain/
├── pipeline/
├── analysis/
├── notification/
└── observability/

test/
├── unit/
├── integration/
└── fixtures/
```

`src/index.ts` 只注册 Handler 和组合依赖，不承载业务逻辑。

## 模块边界

- `api`：路由、Payload 校验和响应。
- `analyzers` / `pipeline`：组织告警处理流程。
- `clients`：GraphQL、LLM 和企业微信调用。
- `domain` / `analysis`：领域契约、标准化、统计和规则。
- `notification`：消息格式化。
- `config` / `observability`：配置、日志和错误分类。

Handler 不写分析逻辑；Client 不做领域判断；AI 不查询 Cloudflare 或重算统计；Formatter 不使用未校验的 LLM 原始输出。

## 统一命名

统一使用 `CloudflareAlertPayload`、`Alert`、`Incident`、`Statistics`、`Finding`、`AIAnalysis`、`incident_id`、`correlation_id`、`webhook_received_at`、`query_started_at`、`processing_started_at` 和 `analysis_window`。

内部字段使用 `camelCase`；外部字段只在边界 Schema 中保留原名。

## Worker Handler 规则

### `fetch()` Handler

只负责路由、Zod 校验、告警类型判断、固定逻辑 `query_started_at` 和 `analysis_window`、Queue 入队，并在成功入队后返回 `202 Accepted`。

不得调用 GraphQL、LLM 或企业微信；入队失败不得返回成功。

### `queue()` Handler

负责校验消息和固定窗口、记录 `processing_started_at`、GraphQL 查询、标准化、统计、规则、AI/降级和企业微信通知，不得重新计算窗口。

MVP 使用 `max_batch_size = 1`。重试必须保留首次确定的窗口。

## 快照窗口规则

```text
query_started_at = webhook_received_at + settle_seconds
start = alert_time - before_minutes
end = query_started_at
```

默认 `before_minutes = 30`、`settle_seconds = 60`、`sample_limit = 50`。

- 使用 Queue 延迟投递，不在 Worker 中 sleep。
- `webhook_received_at` 在 Webhook 通过校验、准备入队时记录。
- `query_started_at` 是逻辑查询开始时间和固定快照截止时间，必须在入队前写入 Queue Message。
- `processing_started_at` 是 Consumer 实际开始处理的时间，仅用于日志和耗时观测。
- 不因数据增长、空数据或低事件量启动第二轮查询。
- 技术重试复用 Queue Message 中的固定窗口，不得重新计算 `query_started_at`。
- 比例使用 GraphQL `total_events`，Payload `events_count` 仅作参考。

## Queue 与重试规则

- Queue 是至少一次投递，不得声称 exactly-once。
- 通知展示 `incident_id` 和 `correlation_id`。
- 临时错误最多有限退避重试 1～2 次。
- LLM 失败执行降级，不触发整条消息重放。
- 企业微信已发送成功后不得再抛出导致 Queue 重试的异常。
- 引入幂等存储、DLQ 或 Workflows 必须创建新 OpenSpec。

## 数据与 Schema 规则

Webhook、Queue Message、vars、外部 API 响应和 LLM 输出都必须经过 Zod 校验。

内部类型优先由 Zod Schema 推导。时间统一为带时区 ISO 8601，内部使用 UTC，仅在通知层转换展示时区。

## Cloudflare GraphQL 规则

- 聚合统计优先使用 `firewallEventsAdaptiveGroups`。
- 使用固定窗口并限制样本数量。
- HTTP `200` 仍须检查 GraphQL `errors`。
- 设置超时，只对临时错误有限重试。
- 不记录 Token、Authorization Header 或大型原始响应。
- Dashboard 核验使用相同窗口，并允许解释采样差异。

## AI 分析规则

- 输入仅包含 Incident、程序计算的 Statistics 和 Findings。
- 结论必须映射到 Evidence；数据不足时返回 `Unknown`。
- 输出必须为结构化 JSON 并通过 Zod 校验。
- 失败时发送规则分析降级通知。
- 不直接发送 LLM 原文，不生成或执行 Cloudflare 配置变更。

## 配置与安全

Workers Secrets：

```text
CLOUDFLARE_API_TOKEN
LLM_API_KEY
WECOM_WEBHOOK_URL
```

Wrangler vars：`LLM_BASE_URL`、`LLM_MODEL` 和业务参数。

Secret 不得进入 Git、`wrangler.jsonc`、文档、测试夹具或日志。本地测试不得使用生产企业微信机器人。未经明确要求，不执行生产部署、Secret 写入或 Cloudflare 资源变更。

## 日志规则

使用单行 JSON 日志，核心字段包括 `incident_id`、`correlation_id`、`analysis_window`、`queue_attempt`、外部 API 状态、耗时和 `error_code`。

日志必须脱敏，并区分输入错误、可重试错误、不可重试错误、AI 降级和通知失败。

## TypeScript 编码规则

- 开启 strict mode，禁止滥用 `any`；外部输入先用 `unknown`。
- 使用 ES Modules 和 Module Worker 格式。
- 统计、规则和格式化优先使用小型纯函数。
- 不使用同步阻塞、主动 sleep 或本地文件持久化。
- 固定 `compatibility_date`；bindings 变化后运行 `wrangler types`。
- 未明确启用并测试时，不依赖 Node.js 专属 API。

## 测试规则

新增或修改行为必须补测试。

- 单元测试：Schema、窗口、Normalizer、Statistics、Rules、Formatter 和降级。
- Workers 集成测试：路由、Payload 校验、Queue、Fetch Mock、重试、降级和日志脱敏。
- 使用 `@cloudflare/vitest-plugin`，不得只在普通 Node.js 环境测试 bindings。
- 夹具只能使用虚构或脱敏数据。

## 常用命令

工程初始化后必须提供：

```text
npm run dev
npm run types
npm run typecheck
npm run lint
npm test
npm run deploy
```

提交实现前至少运行 typecheck、lint 和 test；bindings 变化时额外运行 types。当前无 `package.json`，不得声称命令已经可用。

## 环境与部署规则

至少分离 staging 和 production 的 Worker、Queue、Secrets、企业微信机器人和 API Token。

部署前执行依赖安装、类型检查、Lint、测试、Wrangler 配置校验和 staging 验证。生产部署只有用户明确要求时才能执行。

## OpenSpec 工作流

```text
proposal -> specs -> design -> tasks -> implementation -> verification -> archive
```

- 文档或不改变行为的小修可直接处理。
- 新功能、跨模块、外部契约、Queue、模型、AI、安全或部署变更必须创建 OpenSpec。
- MVP 首次实现必须包含 proposal、delta specs、design 和 tasks。
- 用户确认 artifacts 前不得修改生产代码。
- 实施按 `tasks.md` 推进；范围变化先更新 artifacts。
- 验证通过后同步主 Specs，并归档 Change。

## GitNexus 代码智能

当前无生产代码和 GitNexus 索引。源码形成后运行 `gitnexus status`，必要时执行 `gitnexus analyze`。

- 中大型、跨模块和公共符号变更前使用 `query`、`context` 或 `impact`。
- 完成实现和测试后运行 `gitnexus detect-changes --scope all`。
- HIGH/CRITICAL 风险必须重新核对范围、调用方和测试。
- 索引不可用时，小改动用 `rg`、类型检查和测试降级；高影响重构先修复索引。
- GitNexus 不替代源码阅读、OpenSpec 或测试。

## Agent 实现流程

1. 阅读需求、技术栈和当前 OpenSpec。
2. 检查仓库现状并判断规模、模块和影响范围。
3. 满足 OpenSpec 门禁，适用时执行 GitNexus 分析。
4. 先写失败测试，再实现最小行为。
5. 按模块边界实现，不做无关重构。
6. 运行类型检查、Lint、测试和必要的 GitNexus 检查。
7. 检查 Credential 泄漏并汇报验证结果和风险。

## 禁止事项

- 未确认 OpenSpec 就实现中大型功能。
- 把业务逻辑堆入 `index.ts`、`fetch()` 或 `queue()`。
- 用 `ctx.waitUntil()` 替代可靠 Queue，或在 Worker 中 sleep。
- 技术重试时移动分析窗口。
- 让 LLM 重算统计、补造数据或直接生成通知全文。
- 因 LLM 失败丢失告警。
- 泄漏真实 Credential。
- 未确认就引入框架、存储、队列或云资源。
- 未授权修改生产配置或执行部署。
- 用 GitNexus 替代类型检查、测试或 OpenSpec。
- 未验证就声称完成。

架构存在实质不确定性时，先给出 2～3 个方案、取舍和推荐结论。
