# Cloudflare AI 告警分析系统技术栈

## 1. 文档信息

| 项目 | 内容 |
|---|---|
| 项目名称 | Cloudflare AI Alert Analyzer |
| 中文名称 | Cloudflare AI 告警分析系统 |
| 文档类型 | MVP 技术栈与工程约束 |
| 文档版本 | v0.1 |
| 运行平台 | Cloudflare Workers |
| 主要语言 | TypeScript |
| 部署方式 | Wrangler 直接部署到 Cloudflare Workers |
| 关联文档 | `docs/Cloudflare AI 告警分析系统需求文档.md` |

---

## 2. 技术目标

MVP 技术方案需要满足以下目标：

- 接收 Cloudflare WAF 告警并尽快返回 HTTP 响应
- 在 Cloudflare Workers 平台完成异步分析和企业微信通知
- 对固定时间窗口执行一次性快照分析，不持续跟踪后续事件
- 将确定性统计和规则判断与 LLM 分析分离
- LLM 不可用时仍能发送基础分析结果
- 不自动修改 Cloudflare 配置或执行生产安全变更
- 不依赖自建服务器、容器、数据库或外部消息队列
- Credential 仅通过 Cloudflare Workers Secrets 管理

---

## 3. 总体技术选型

| 类别 | 选型 | 用途 |
|---|---|---|
| 开发语言 | TypeScript | Worker、领域模型、规则和外部 API 编排 |
| 运行平台 | Cloudflare Workers | HTTP 接入与后台分析运行时 |
| HTTP 入口 | Workers 原生 `fetch()` Handler | 接收 Cloudflare Webhook |
| 异步任务 | Cloudflare Queues | 延迟投递、任务解耦和有限重试 |
| HTTP 客户端 | Workers 原生 Fetch API | 调用 Cloudflare GraphQL、LLM 和企业微信 |
| 数据校验 | Zod | 校验告警 Payload、内部模型和 LLM 输出 |
| 配置管理 | Wrangler vars | 管理非敏感业务配置 |
| 密钥管理 | Workers Secrets | 管理 Token、API Key 和 Webhook Secret |
| 开发与部署 | Wrangler | 本地开发、类型生成、配置和部署 |
| 单元与集成测试 | Vitest、`@cloudflare/vitest-plugin` | 在 Workers 运行时中测试业务和 bindings |
| 静态检查 | TypeScript Compiler、ESLint | 类型检查和代码质量检查 |
| 日志 | Workers Logs、结构化 `console` 日志 | 处理链路追踪和异常诊断 |
| 包管理 | npm | 依赖安装、脚本和锁文件管理 |

### 3.1 版本策略

- 使用仍处于维护期的 Node.js LTS 版本作为本地工具链环境
- TypeScript、Wrangler、Vitest 和 Workers 测试插件在 `package.json` 中声明明确版本范围
- 使用 `package-lock.json` 锁定可重复安装的依赖版本
- Zod 使用 4.x，最低采用 4.5.0
- Vitest 使用 4.1 或更高兼容版本
- Workers `compatibility_date` 必须显式固定，不自动跟随最新日期
- 修改 `wrangler.jsonc` 的 bindings 或兼容性配置后，重新运行 `wrangler types`

---

## 4. 选型说明

### 4.1 TypeScript

TypeScript 是 Cloudflare Workers 的一等支持语言，适合本项目以 JSON API 编排和结构化数据处理为主的工作负载。

主要优势：

- Workers Runtime API 和 bindings 具备完整类型
- 与 Fetch API、Queues、Secrets 和 Wrangler 直接集成
- 使用 Zod 可以统一运行时校验和 TypeScript 类型推导
- 使用 Vitest 可以在接近生产的 Workers Runtime 中测试
- 当前项目没有既有 Python 代码，不存在迁移成本

### 4.2 Workers 原生 Handler

MVP 仅包含一个主要 Webhook 接口，不引入 Hono、Express 等 Web 框架，直接使用 Workers 原生 Handler：

```text
fetch(request, env, ctx)
queue(batch, env, ctx)
```

当后续接口数量、路由或中间件复杂度明显增加时，再评估引入轻量 Web 框架。

### 4.3 Cloudflare Queues

Webhook 需要快速响应，而分析链路包含数据缓冲、GraphQL、LLM 和企业微信调用，不适合依赖 HTTP 请求生命周期或 `ctx.waitUntil()` 完成。

Cloudflare Queue 用于：

- Webhook 接收与分析任务解耦
- 将消息默认延迟 `settle_seconds` 后交给消费者
- 避免 Worker 返回响应后后台任务被取消
- 对 Worker 意外终止等基础设施故障提供有限重试

MVP 使用一条分析队列。同一个 Worker 项目同时提供生产者和消费者 Handler，不拆分为多个独立服务。

---

## 5. 系统运行架构

```text
Cloudflare WAF Alert
         |
         v
Cloudflare Worker fetch()
         |
         +-- Payload Validation
         +-- Alert Normalization
         +-- Fix Logical Snapshot Window
         +-- Queue.send(delaySeconds)
         |
         v
HTTP 202 Accepted

Cloudflare Queue
         |
         | delay: settle_seconds
         v
Cloudflare Worker queue()
         |
         +-- Validate Fixed Snapshot Window
         +-- Record Processing Start
         +-- Cloudflare GraphQL
         +-- Data Normalizer
         +-- Statistics
         +-- Rules
         +-- LLM Analysis / Fallback
         +-- WeCom Formatter
         +-- WeCom Webhook
         v
Message Acknowledged
```

### 5.1 HTTP 接入流程

`fetch()` Handler 仅负责：

1. 校验 HTTP 方法和路由
2. 解析并校验 Cloudflare Payload
3. 判断是否为 MVP 支持的 WAF 告警
4. 构造内部 Alert 消息
5. 记录 `webhook_received_at`，按照 `query_started_at = webhook_received_at + settle_seconds` 固定逻辑查询时间和分析窗口
6. 将固定窗口写入消息并发送到 Cloudflare Queue
7. 返回 `202 Accepted`

HTTP Handler 不执行 GraphQL、LLM 或企业微信调用。

### 5.2 Queue 消费流程

`queue()` Handler 校验并复用 Queue Message 中已经固定的窗口，对每条有效消息执行一轮数据采集和分析：

```text
query_started_at = webhook_received_at + settle_seconds
start = alert_time - before_minutes
end = query_started_at
```

Consumer 实际启动时记录 `processing_started_at`，该字段仅用于日志和耗时观测，不参与窗口计算。同一轮可以按统计维度发起多个 GraphQL 请求，但不得因结果增长启动新一轮数据采集。技术故障重试必须复用 Queue Message 中的固定分析窗口。

### 5.3 Queue 建议配置

MVP 建议采用以下配置：

```text
delivery_delay = 60 seconds
max_batch_size = 1
max_batch_timeout = 5 seconds
max_retries = 2
```

`max_batch_size` 设为 1，避免一条异常消息影响同一批次中的其他告警。Queue 的自动重试主要处理 Worker 意外终止等异常；业务 API 的可预期错误由客户端模块进行有限重试或降级。

Cloudflare Queues 提供至少一次投递语义，极端情况下可能产生重复通知。MVP 在消息中展示 `incident_id` 和 `correlation_id` 便于识别重复；若后续要求严格去重，再引入 KV、D1 或 Durable Object 保存幂等状态。

---

## 6. 应用模块

| 模块 | 职责 |
|---|---|
| API | 路由、Payload 校验和 HTTP 响应 |
| Dispatcher | 将外部告警类型映射到内部 Analyzer |
| WAF Analyzer | 组织 WAF 数据采集和分析流程 |
| Cloudflare Client | 调用 GraphQL Analytics API |
| Normalizer | 将外部数据转换为统一 Incident |
| Statistics | 计算事件总量、集中度和 Action 比例 |
| Rules | 根据配置阈值生成确定性 Findings |
| AI Client | 调用兼容接口并校验结构化输出 |
| AI Analyzer | 基于 Incident、Statistics 和 Findings 生成分析 |
| Notification | 生成并发送企业微信消息 |
| Config | 读取并校验 Workers vars 和 Secrets |
| Logging | 输出脱敏的结构化日志 |

模块之间通过明确的数据类型交互，不直接传递 Cloudflare GraphQL 原始响应或 LLM 原始文本。

---

## 7. 推荐项目结构

```text
.
├── docs/
├── openspec/
├── src/
│   ├── index.ts
│   ├── api/
│   │   └── cloudflare-alert.ts
│   ├── analyzers/
│   │   └── waf-analyzer.ts
│   ├── clients/
│   │   ├── cloudflare-graphql.ts
│   │   ├── llm.ts
│   │   └── wecom.ts
│   ├── config/
│   │   ├── env.ts
│   │   └── rules.ts
│   ├── domain/
│   │   ├── alert.ts
│   │   ├── incident.ts
│   │   ├── finding.ts
│   │   └── ai-analysis.ts
│   ├── pipeline/
│   │   ├── dispatcher.ts
│   │   └── process-alert.ts
│   ├── analysis/
│   │   ├── normalizer.ts
│   │   ├── statistics.ts
│   │   └── rules.ts
│   ├── notification/
│   │   └── formatter.ts
│   └── observability/
│       └── logger.ts
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── package.json
├── package-lock.json
├── tsconfig.json
├── vitest.config.ts
├── eslint.config.js
└── wrangler.jsonc
```

`src/index.ts` 只负责注册 `fetch()` 和 `queue()` Handler，不承载具体业务逻辑。

---

## 8. 数据校验和类型

Zod Schema 是外部输入和外部输出的运行时契约，至少覆盖：

- Cloudflare Alert Payload
- Queue Message
- Alert
- Incident
- Statistics
- Finding
- AIAnalysis
- LLM Structured Output
- Workers vars 配置

内部 TypeScript 类型优先从 Zod Schema 推导，避免分别维护类型和运行时校验规则。

LLM 返回内容必须先经过 Zod 校验。校验失败视为 AI 不可用，系统转为规则分析降级通知，不得直接发送未校验的 LLM 原始输出。

---

## 9. 外部 API

### 9.1 Cloudflare GraphQL

- 使用 Workers Fetch API 调用
- 使用 Bearer Token 鉴权
- 使用固定的 `analysis_window` 查询
- 聚合统计优先使用 `firewallEventsAdaptiveGroups`
- 样本查询使用适合 Security Events 的数据集
- 每个请求设置超时
- 对超时、`429` 和 `5xx` 进行 1～2 次有限退避重试
- GraphQL HTTP `200` 响应仍必须检查 `errors` 字段
- 不得在日志中记录 Authorization Header 或完整 Token

### 9.2 LLM API

- 使用 OpenAI 兼容的 HTTP API，由 `LLM_BASE_URL` 和 `LLM_MODEL` 配置
- 输入仅包含标准化 Incident、Statistics 和 Findings
- 使用结构化 JSON 输出
- 设置请求超时和最大输出长度
- 不允许 LLM 重新计算确定性统计
- 调用失败、超时或 Schema 校验失败时执行规则分析降级

### 9.3 企业微信

- 由 Formatter 生成固定格式消息
- 消息中的事实数据来自 Incident 和 Statistics
- AI 内容只能写入 AI 分析区域
- 发送失败时在当前消费者执行 1～2 次有限重试
- 通知重试不得触发 Cloudflare 数据重新查询或 LLM 重新分析

---

## 10. 配置和密钥

### 10.1 Workers Secrets

以下配置必须作为加密 Secret 管理：

```text
CLOUDFLARE_API_TOKEN
LLM_API_KEY
WECOM_WEBHOOK_URL
```

Secret 不得出现在：

- Git 仓库
- `wrangler.jsonc`
- 日志
- 测试夹具
- README 或其他文档示例值

### 10.2 Dashboard vars 与 Wrangler vars

以下非敏感配置在单环境部署中通过 Worker Dashboard 的普通 Text 变量管理：

```text
LLM_BASE_URL
LLM_MODEL
```

业务参数通过 `wrangler.jsonc` 的 JSON var 管理：

```json
{
  "beforeMinutes": 30,
  "settleSeconds": 60,
  "sampleLimit": 50,
  "rules": {
    "ipConcentration": { "medium": 30, "high": 50 },
    "pathConcentration": { "medium": 30, "high": 50 },
    "allowRatio": { "medium": 50, "high": 80 }
  }
}
```

应用启动或首次处理请求时必须校验配置。缺少必要配置时应快速失败并输出不含 Secret 的错误日志。

---

## 11. 日志和可观测性

使用 JSON 结构化日志，至少包含：

```text
incident_id
correlation_id
alert_type
zone_name
alert_time
analysis_window
query_started_at
processing_started_at
queue_attempt
cloudflare_api_status
llm_api_status
wecom_status
processing_duration_ms
error_code
```

日志要求：

- 禁止输出 Token、API Key、Webhook Secret 和完整请求 Header
- 对外部 API 错误响应进行截断和脱敏
- 每条处理链路统一使用 `incident_id`
- 区分业务降级、可重试错误和不可重试错误
- 使用 Workers Logs 查看运行日志和异常
- MVP 不额外引入第三方 APM

---

## 12. 测试策略

### 12.1 单元测试

使用 Vitest 测试纯业务模块：

- Payload 和配置 Schema
- 分析窗口计算
- Normalizer
- Statistics
- Rules
- LLM 输出校验
- 企业微信消息格式化

### 12.2 集成测试

使用 `@cloudflare/vitest-plugin` 在 Workers Runtime 中测试：

- `fetch()` 路由、Payload 校验和 HTTP 状态码
- Queue binding 和 Queue Message
- GraphQL、LLM、企业微信客户端的 Fetch Mock
- LLM 失败后的降级通知
- 外部 API 超时、`429` 和 `5xx` 重试
- Secret 不进入日志

### 12.3 测试夹具

测试夹具包括：

- 脱敏的 Cloudflare WAF Alert Payload
- 脱敏的 GraphQL 聚合响应和样本响应
- 正常和异常的 LLM Structured Output
- 企业微信消息快照

所有测试数据必须使用虚构域名、IP、Token 和 Webhook 地址。

---

## 13. 本地开发和部署

### 13.1 本地工具

本地开发需要：

- Node.js LTS
- npm
- Wrangler

常用工程命令应通过 `package.json` scripts 统一提供：

```text
npm run dev
npm run typecheck
npm run lint
npm test
npm run deploy
```

### 13.2 本地运行

使用 `wrangler dev` 启动本地 Worker。开发环境的 Secret 使用 Wrangler 支持的本地 Secret 文件，并加入 `.gitignore`。

本地测试不得调用真实企业微信机器人。外部 API 默认使用 Mock，仅在明确的集成环境中使用测试凭证。

### 13.3 环境配置

MVP 使用一套直接运行配置：

- Worker：`cloudflare-ai-alert-analyzer`
- Queue：`cloudflare-ai-alert-analyzer`
- 三项 Credential 在 Worker Dashboard 中保存为 Secret
- `LLM_BASE_URL` 和 `LLM_MODEL` 在 Worker Dashboard 中保存为普通 Text 变量
- `BUSINESS_CONFIG` 由 `wrangler.jsonc` 提供非敏感 JSON 配置

本地测试仍必须使用虚构或脱敏数据和 Mock，不得调用已部署 Worker 使用的真实企业微信机器人。

### 13.4 部署流程

部署前必须执行：

```text
依赖安装
    ↓
TypeScript 类型检查
    ↓
ESLint
    ↓
Vitest
    ↓
Wrangler 配置校验
    ↓
Wrangler Deploy
    ↓
Webhook 健康检查
```

MVP 不生成 Docker 镜像，不使用 Docker Compose，不维护服务器或 Uvicorn 进程。

---

## 14. MVP 明确不采用的技术

| 技术 | MVP 不采用的原因 |
|---|---|
| Python / FastAPI / Uvicorn | 运行目标已确定为 Workers，TypeScript 更贴合平台原生工具链 |
| Docker / Docker Compose | Workers 由平台托管，不需要容器运行时 |
| PostgreSQL / MySQL | MVP 不保存历史 Incident |
| D1 / KV / Durable Objects | MVP 暂不提供历史存储和严格幂等去重 |
| Redis / Celery / Kafka | 使用 Cloudflare Queues 完成异步任务 |
| Kubernetes | Workers 平台负责扩缩容和运行时管理 |
| Hono / Express | MVP 路由简单，原生 Handler 足够 |
| RAG / Vector Database | 不属于 MVP 分析范围 |
| 自动化 WAF 变更 | MVP 只读，不执行生产安全变更 |

---

## 15. 已知约束和风险

### 15.1 Queue 重复投递

Cloudflare Queues 是至少一次投递，极端情况下可能重复执行分析并发送通知。MVP 接受该限制，并通过 `incident_id` 和 `correlation_id` 识别重复。

### 15.2 数据采样和延迟

Cloudflare Security Events 数据可能存在采样或短暂聚合延迟。MVP 在 Queue 中固定延迟后执行一次快照分析，不进行数据收敛轮询。

### 15.3 Worker 资源限制

实现需要控制：

- GraphQL 返回记录数量
- LLM 输入和输出长度
- 单次分析的内存占用
- 外部 HTTP 请求数量和超时时间
- Queue Consumer 的 CPU 时间和总执行时间

### 15.4 外部依赖失败

- Cloudflare API 失败时不得调用 LLM 编造结论
- LLM 失败时发送规则分析降级通知
- 企业微信失败时有限重试并记录最终状态

---

## 16. 后续演进

当 MVP 出现明确需求后，再按以下方向演进：

| 场景 | 候选技术 |
|---|---|
| 严格幂等和告警状态 | D1 或 Durable Objects |
| 简单幂等标记和短期缓存 | Workers KV |
| 历史 Incident 和趋势分析 | D1、外部 PostgreSQL 或 R2 |
| 原始事件归档 | R2 |
| 多步骤长时间分析 | Cloudflare Workflows |
| 独立失败消息处理 | Queue Dead Letter Queue |
| 多告警类型 | Dispatcher + 独立 Analyzer |
| 持续事件跟踪 | Queue、Workflow 或 Durable Object Alarm |
| 更完整可观测性 | Workers Traces、Tail Worker 或外部 APM |

任何后续技术引入都应由实际容量、可靠性或产品需求驱动，不提前增加 MVP 复杂度。

---

## 17. 官方参考资料

- [Cloudflare Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/)
- [Cloudflare Workers Handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/)
- [Cloudflare Workers Context](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare Queues 延迟与重试](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Workers Vitest 集成](https://developers.cloudflare.com/workers/testing/vitest-integration/)
- [Cloudflare Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
