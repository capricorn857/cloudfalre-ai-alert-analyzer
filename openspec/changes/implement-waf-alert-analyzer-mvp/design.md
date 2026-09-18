# 设计说明：Cloudflare WAF 告警分析 MVP

## Context

当前 MVP 已完成 Worker 工程和主要业务链路。生产验收确认 Webhook、Queue producer、Consumer 和固定窗口正常，但发现两条可观测性缺口：WeCom Fetch 异常经过通用分类后统一成为 `wecom_unexpected`，底层失败类型丢失；最终 `notification_failed` 日志只记录快照状态，没有传播 GraphQL `collection_failed` 的具体 `errorCode`。现有 Logger 能递归脱敏和截断，但 Pipeline 直接传入原始 `Error`，诊断字段尚未形成稳定契约。此外，Cloudflare Generic Webhook 创建目的地时发送的官方测试 Payload 只有 `text`，当前入口直接用真实 WAF Schema 校验并返回 `400`，导致 “Save and Test” 失败。

本次修订增强三类外部 HTTP 客户端、分析结果、Pipeline 和 Logger 之间的失败上下文，并在 Webhook 入口增加一个无副作用的官方测试握手分支；真实 WAF 告警处理流程保持不变。目标行为仍由本 Change 的五份 delta Specs 定义，并遵守 Cloudflare Workers 的运行时与资源约束。

关键约束如下：

- 使用 TypeScript、Module Worker、Cloudflare Queues、原生 Fetch API、Zod、Wrangler、Vitest 和 ESLint。
- `fetch()` 只校验、映射、固定窗口和入队；`queue()` 编排一次快照分析。
- 不使用数据库、KV、Durable Objects、Workflows、第三方队列、容器或新的 LLM SDK。
- 所有外部输入与输出先作为 `unknown`，通过 Zod 后才进入领域层。
- 只读分析，不执行 Cloudflare 配置变更。

## Goals / Non-Goals

**Goals:**

- 建立可在 Workers Runtime 中测试的单 Worker、单 Queue MVP。
- 通过不可变 Queue Message 保证延迟投递与技术重试共享同一分析窗口。
- 将确定性事实、规则判断、AI 推断和通知呈现严格分层。
- 对 Cloudflare、LLM 和企业微信失败采用与业务语义匹配的有限重试或降级。
- 用可关联、脱敏的 JSON 日志支持单环境验收和故障定位。
- 让外部依赖最终失败以稳定字段跨越 Client、Analyzer/AI 和 Pipeline 边界，并能查询传输、HTTP、协议和服务级失败。
- 在最终通知失败日志中保留 WeCom 失败上下文和已有 GraphQL 快照错误码，同时不重新执行任何上游阶段。
- 让 Cloudflare 官方 Generic Webhook 测试请求在真实 WAF 校验前通过独立 Schema 被识别并无副作用地返回 `200`。

**Non-Goals:**

- 持久化 Incident、严格幂等、DLQ、持续跟踪、二次快照或初报/终报。
- Web UI、历史检索、用户权限、自动化安全变更。
- 抽象通用工作流引擎或为尚未支持的告警类型实现 Analyzer。
- 引入代理、中转服务、持久化组件、新 SDK，或改变 Queue Message、固定窗口、有限重试和至少一次投递语义。
- 在本 Change 中创建远端 Cloudflare 资源、写入真实 Secrets 或执行远端部署。
- 放宽真实 WAF Payload 校验、接受任意文本请求或实现 `cf-webhook-auth`。

## 总体方案

同一个 Module Worker 暴露 `fetch` 与 `queue` Handler。`fetch` 将公网输入收敛成经过校验的 `QueueMessage` 并以 `settleSeconds` 延迟入队；`queue` 校验固定窗口后，调用 WAF 分析 Pipeline。Pipeline 只执行一次 Cloudflare 数据快照，随后依次标准化、统计、规则分析、可选 AI 分析、格式化与企业微信发送。

```text
POST /api/v1/alerts/cloudflare
  -> route/body/schema validation
  -> official webhook test schema?
     -> yes: 200 {"message":"Webhook test accepted"}; stop
     -> no: continue real WAF validation
  -> CloudflareAlertPayload -> Alert
  -> fix webhook_received_at/query_started_at/analysis_window
  -> Queue.send(message, delaySeconds)
  -> 202

Queue<QueueMessage> (max_batch_size = 1)
  -> validate message and fixed window
  -> collect GraphQL snapshot
  -> normalize Incident
  -> calculate Statistics
  -> evaluate Findings
  -> request/validate AIAnalysis or build fallback
  -> format immutable WeCom message
  -> send with isolated retry
  -> acknowledge
```

## 组件与边界

| 模块 | 责任 | 明确不负责 |
|---|---|---|
| `src/index.ts` | 注册 Handler、组合依赖 | 路由细节、分析、重试、格式化 |
| `src/api/` | 路由、体积限制、Payload 校验、HTTP 响应 | GraphQL、LLM、企微调用 |
| `src/domain/` | Zod 契约及推导类型 | 网络 I/O、流程编排 |
| `src/pipeline/` | 固定窗口、告警分发、消费流程编排、结构化失败日志 | 外部响应解析细节、底层异常文本分类、统计算法 |
| `src/analyzers/` | 组织 WAF 所需数据和分析步骤 | Handler 路由、通知传输 |
| `src/clients/` | Fetch、超时、HTTP/协议校验、阶段内重试、稳定外部失败分类和耗时 | 领域风险判断、消息格式、直接写业务日志 |
| `src/analysis/` | 标准化、统计、规则纯函数 | 网络 I/O、AI 文案 |
| `src/notification/` | 事实/AI 分区格式化和长度控制 | 使用未校验 LLM 文本、重算统计 |
| `src/config/` | env 与业务参数校验 | 静默修正危险配置 |
| `src/observability/` | 结构化错误契约、分类、安全诊断摘要、脱敏单行 JSON 日志 | 输出 Secret、敏感 URL、原始外部响应或大型异常对象 |

依赖方向为 Handler -> Pipeline -> 领域服务/Clients。Clients 只依赖通用错误与自身响应 Schema；纯领域模块不依赖 Worker bindings。所有时间由注入的时钟产生，所有网络由注入的 `fetch` 或窄接口执行，便于 Workers Runtime 测试。

## 数据与接口契约

### 边界 Schema

领域契约按文件拆分，并用 Zod 推导 TypeScript 类型：

- `CloudflareAlertPayloadSchema`：仅在 Webhook 边界保留 Cloudflare 字段名。
- `CloudflareWebhookTestPayloadSchema`：独立校验字符串 `text`，并要求其包含完整官方测试标记；不与真实 WAF Payload 组成宽松联合 Schema。
- `AlertSchema`：内部 camelCase 命名，保留原始事件数参考值，但不保留无限制原始 Payload。
- `AnalysisWindowSchema`：UTC `start` 与 `end`，验证 `start <= end`。
- `QueueMessageSchema`：`alert`、`incidentId`、`correlationId`、`webhookReceivedAt`、`queryStartedAt`、`analysisWindow` 和计算窗口使用的配置快照。
- `CloudflareGraphQLResponseSchema`：分别校验聚合与样本响应，包括 HTTP 200 下的 GraphQL `errors`。
- `IncidentSchema`、`StatisticsSchema`、`FindingSchema`、`AIAnalysisSchema`：模块间唯一允许传递的分析数据。
- `EnvSchema` 与 `BusinessConfigSchema`：将字符串 vars 解析成有范围约束的只读配置。

`incident_id` 优先使用稳定的 `alert_correlation_id`；若外部值不满足内部标识约束，则在入队前生成并固化新的 UUID。`correlation_id` 始终保留外部关联值。两者在 Queue 重试中均不改变。

### Webhook 测试握手

入口完成路由、方法、体积限制、请求体读取和 JSON 解析后，先调用由 `CloudflareWebhookTestPayloadSchema` 支持的小型纯函数识别官方测试请求。只有 `text` 包含完整官方普通 URL 标记 `This is a test message sent from https://cloudflare.com.` 时才返回 `200` 与 `{"message":"Webhook test accepted"}`；Markdown 链接变体不属于官方契约。该分支在 `parseEnv`、时钟读取、`buildQueueMessage` 和 `Queue.send` 之前结束，因此不会计算窗口或触发任何出站请求。

不满足测试 Schema 的输入继续进入原有 `CloudflareAlertPayloadSchema`。因此任意 `{"text":"hello"}`、带普通 `text` 但缺少真实告警字段的对象以及畸形 JSON 仍按输入错误返回 `400`；有效真实 WAF 告警继续只在 Queue 写入成功后返回 `202`。

### 外部失败契约

Client 边界将最终失败转换为稳定的结构化对象，供 Analyzer、AI 编排和 Pipeline 传播：

```text
externalService
errorCode
failureKind
retryable
durationMs
httpStatus?
responseCategory?
diagnosticName?
diagnosticMessage?
```

日志输出使用对应的 snake_case 字段：`external_service`、`error_code`、`failure_kind`、`retryable`、`duration_ms`，并按适用情况增加 `http_status`、`response_category`、`diagnostic_name` 和 `diagnostic_message`。`duration_ms` 表示一次外部操作从首次尝试到最终结果的总耗时，包含该 Client 内部的有限重试和短退避。

`failureKind` 固定为 `timeout`、`network`、`dns`、`tls`、`connection`、`http`、`invalid_response`、`service_error` 或 `unknown`。DNS、TLS 和 connection 仅在 Workers Runtime 暴露可识别信号时细分；普通 Fetch `TypeError` 回退为 `network`，非 Fetch 且无法识别的异常回退为 `unknown`。分类不得依赖记录原始异常才能解释。

WeCom 的 `responseCategory` 固定为 `transport_error`、`http_error`、`invalid_response`、`api_error` 或 `success`。HTTP 错误同时保留 `httpStatus`；非零 `errcode` 映射为 `api_error` 并保持不可重试；非法 JSON 或 Schema 不符映射为 `invalid_response`。不保留 `errmsg`、原始响应体或 Webhook 地址。

诊断名称和消息是可选字段。若保留，必须在离开分类边界前完成已知 Secret 替换、Webhook URL 及敏感 query 清除和长度限制；Pipeline 只接收安全摘要，不接收原始异常。Logger 在序列化前再次执行敏感键过滤、Secret 替换和截断，作为纵深保护。

### 窗口和时间

窗口只在 `fetch` 路径计算一次：

```text
webhook_received_at = clock.now()
query_started_at = webhook_received_at + settle_seconds
analysis_window.start = alert_time - before_minutes
analysis_window.end = query_started_at
```

Queue Message 同时保存计算结果和 `beforeMinutes`/`settleSeconds` 配置快照。Consumer 校验等式但不基于当前配置修正消息，从而避免配置变更改变在途消息语义。`processing_started_at` 只写日志。

### GraphQL 数据采集

Cloudflare Client 使用 `firewallEventsAdaptiveGroups` 获取 `total_events` 和各维度聚合，并使用受限查询获取最多 `sampleLimit` 条样本。所有查询共享 `zoneTag`、`analysisWindow.start` 和 `analysisWindow.end`，变量与 Query 文本分离，Token 只进入 Authorization Header。

选择“少量按用途拆分的查询”，而不是一个超大查询：聚合与样本失败可以清晰分类，响应 Schema 较小，也便于限制样本。它们仍属于同一轮业务快照，不得因空结果再次采集。

### 统计和规则

Normalizer 只做字段映射、允许值归一和缺失值处理。Statistics 使用 GraphQL `total_events` 为唯一比例分母；零分母返回 `null`/数据不足状态，不返回零比例来暗示已观察到分布。显示层统一格式化到一位小数，内部保留足够精度。

Rules 接收 `Statistics`、受限样本和已校验阈值，输出可序列化 Findings。每个 Finding 包含稳定 `type`、`level`、原始数值、阈值和 Evidence 引用。首期规则全部是纯函数，不在规则内部读取 env。

### AI 契约

LLM Client 使用配置的 OpenAI 兼容 HTTP endpoint，不引入 SDK。Prompt 分为固定系统约束和一个结构化输入对象；不包含原始 GraphQL 响应或 Credential。返回体先解析协议层，再提取 JSON，再由 `AIAnalysisSchema` 校验，并执行 Evidence 交叉检查：关键实体和值必须能在输入中找到，建议不得声称已执行变更。

若任一环节失败，Pipeline 构造显式 `AIUnavailable` 状态。该状态不是异常终止，不触发 Queue 重放。

### 通知契约

Formatter 接收一个判别联合：成功 AI、AI 降级、空数据或 Cloudflare 采集失败。它生成固定的企业微信文本消息，始终优先保留身份标识、窗口、数据截至时间和状态。Top 列表与各文本字段有固定上限，总长度在发送前校验；截断只发生在 Formatter。

通知时间按配置展示时区转换，领域数据保持 UTC。WeCom Client 只接受已经完成格式化的字符串，因此通知传输重试不会触发上游计算。

## Decisions

### Decision 1: 单 Worker + 单 Queue

选择一个 Worker 同时实现 producer 与 consumer，并用一条分析 Queue 解耦。

- 优点：最少的部署单元、Bindings 和跨服务契约，符合 MVP。
- 放弃方案：拆分 ingestion/analysis Worker，会增加部署、版本和消息兼容成本；`ctx.waitUntil()` 无法提供所需可靠投递和延迟语义。

### Decision 2: 入队前固定窗口

选择在 Webhook 通过校验后立即固定逻辑截止时间，并通过 Queue 延迟等待数据可用。

- 优点：重试口径稳定，可与 Dashboard 使用同一窗口核验。
- 放弃方案：Consumer 按实际启动时间计算会随排队和重试漂移；轮询数据收敛属于持续跟踪，超出 MVP。

### Decision 3: 无持久化幂等

接受 Queue 至少一次语义，依靠稳定身份标识识别极端重复。

- 优点：不引入没有产品需求支撑的 D1/KV/Durable Objects。
- 代价：消费者在特定故障点可能发送重复通知。严格去重必须作为新 Change 评估存储和一致性。

### Decision 4: Clients 拥有阶段内重试

GraphQL 与 WeCom Client 对明确的临时错误做 1 至 2 次短退避重试，Pipeline 决定最终降级或 Queue 失败。LLM 不可用直接降级。

- 优点：重试不会跨越阶段边界，WeCom 重试不重复分析，LLM 失败不重放整条消息。
- 放弃方案：对任何错误统一抛给 Queue 会重复 GraphQL、LLM 甚至通知，且窗口虽固定仍浪费资源。

### Decision 5: Zod Schema 作为运行时契约源

外部输入、Queue、领域对象、配置和外部输出均先校验，并从 Schema 推导类型。

- 优点：避免 TypeScript 类型与运行时事实分离，Queue 消息也能防止版本或手工注入错误。
- 放弃方案：仅使用 TypeScript interface 无法保护运行时边界；手写成对校验器容易漂移。

### Decision 6: 确定性分析先于 AI

程序计算 Statistics 与 Findings，AI 只解释和提供受 Evidence 限制的建议。

- 优点：统计可测试、可核验；LLM 失败时仍有完整基础信息。
- 放弃方案：让 LLM 读取原始事件并计算会增加幻觉、成本和不可复现性。

### Decision 7: 依赖注入到窄接口

Pipeline 依赖 `CloudflareAnalyticsClient`、`AIAnalysisClient`、`NotificationClient`、`Logger` 和 `Clock` 等窄接口，`index.ts` 只负责实例化。

- 优点：保留模块边界并可在 Workers 集成测试中替换网络行为。
- 放弃方案：全局单例或在领域函数中直接调用 `fetch` 会隐藏依赖并使重试边界难以测试。

### Decision 8: Client 分类、Pipeline 记录、Logger 纵深脱敏

Client 负责将 Fetch、HTTP 和响应校验失败转换为结构化外部失败；Analyzer 和 AI 降级结果负责无损传播；Pipeline 负责按处理阶段记录；Logger 负责最终脱敏与序列化。

- 优点：错误分类最接近协议边界，Pipeline 不需要解析运行时异常，同时日志策略仍集中且可测试。
- 放弃方案：由每个 Client 直接写日志会分散关联字段并产生重复事件；由 Pipeline 解析原始异常会泄漏 Client 实现并扩大敏感数据传播范围。

Cloudflare `collection_failed` 结果携带其结构化失败；LLM 失败的 `AIUnavailable` 可携带结构化失败但仍执行规则降级；WeCom 最终失败以结构化异常到达 Pipeline。Pipeline 为每个最终外部失败记录稳定字段，并在 `notification_failed` 中额外写入 `snapshot_error_code`（仅当快照为 `collection_failed`）。任何一条日志都不包含原始响应、Headers、完整 URL 或原始 `Error` 对象。

### Decision 9: 独立测试 Schema 在真实告警校验前短路

选择独立 Zod Schema 和纯识别函数，而不是扩展 `CloudflareAlertPayloadSchema` 的联合类型或在 Handler 中接受任意 `text`。

- 优点：官方测试契约与真实告警契约隔离，真实 WAF 字段仍保持严格必填；纯函数可直接测试，副作用边界明确。
- 放弃方案：将测试 Payload 加入真实告警联合类型会扩大后续类型分支并增加误用机会；内联字符串判断不利于边界契约复用；任意 `text` 成功会扩大未鉴权公网入口的滥用面。

## 错误处理

错误类型分为：

| 分类 | 示例 | 行为 |
|---|---|---|
| `input_invalid` | Webhook/Queue Schema 失败 | 拒绝或确认丢弃，不调用下游 |
| `config_invalid` | 缺 Secret、阈值非法 | 快速失败，脱敏记录 |
| `dependency_retryable` | timeout、429、5xx | 当前 Client 有限重试 |
| `dependency_permanent` | 401、协议/Schema 错误 | 不做盲目重试，进入对应失败路径 |
| `ai_degraded` | LLM 或 AI Schema 失败 | 规则降级并继续通知 |
| `notification_failed` | WeCom 最终失败 | 记录最终状态并确认消息，禁止 Queue 重放整条分析链 |
| `post_send_noncritical` | 成功发送后的日志异常 | 吞并并确认消息，避免重复通知 |

外部依赖最终失败按以下映射记录：

| 失败来源 | `failure_kind` | 附加字段 | 重试语义 |
|---|---|---|---|
| Abort/timeout | `timeout` | 安全诊断摘要可选 | 可重试 |
| Fetch `TypeError` | 可识别时为 `dns`/`tls`/`connection`，否则 `network` | 安全诊断摘要可选 | 可重试 |
| 其他无法识别异常 | `unknown` | 安全诊断摘要可选 | 不盲目重试 |
| HTTP 非成功 | `http` | `http_status` | `429`/`5xx` 可重试，其余不可重试 |
| JSON/Schema 无效 | `invalid_response` | `response_category=invalid_response`（WeCom） | 不重试 |
| WeCom 非零 `errcode` | `service_error` | `response_category=api_error` | 保持不可重试 |

所有超时使用 `AbortSignal.timeout` 或兼容的 AbortController 方案，并在 Client 边界转换为稳定错误码。退避不得使用长时间主动 sleep；短暂客户端退避必须受配置和 Worker 执行预算约束。原始响应、Authorization、Token、API Key、Webhook URL、Webhook key 和大型异常对象禁止进入日志上下文。

Queue `max_batch_size = 1`，使确认只对应一个事件。无效 Queue Message 作为不可重试毒消息处理，记录后确认，避免无限重放。GraphQL 最终失败仍尝试发送基础异常通知。WeCom Client 在同一次消费中完成有限重试；若仍失败，Pipeline 记录 `notification_failed` 并确认 Queue Message，不把通知失败抛给 Queue，因为整条消息重放会重新查询 GraphQL 和重跑 AI。MVP 接受最终通知失败需要通过日志人工补偿；若要求可靠的通知级重放，应以新 OpenSpec 引入独立通知任务或持久化状态。

## 兼容与恢复

这是首次实现，无历史应用数据迁移。兼容重点是消息版本和配置发布：

- `QueueMessage` 包含显式 `schemaVersion: 1`。Consumer 对未知版本记录不可重试错误，不猜测字段。
- 发布前由人工准备单一 Queue、Dashboard vars 和 Secrets，再部署同时兼容 producer/consumer 的 Worker；本 Change 只生成操作清单，不自动执行远端操作。
- 配置或代码回滚通过 Wrangler 部署上一已验证版本完成。由于没有持久化数据，不需要数据回滚。
- 回滚期间已经入队的 v1 消息必须由回滚版本继续支持；若未来破坏消息契约，应先部署双读 Consumer，再升级 producer。
- 企业微信成功是不可逆外部副作用。成功返回后任何本地非关键失败不得升级为 Queue retry。
- 新增日志字段和内部失败上下文为向后兼容的增量，不修改 Webhook、Queue Message 或外部服务请求契约，也不需要数据迁移。
- 新增官方测试握手是 Webhook 的向后兼容响应分支；真实 WAF、Queue Message、固定窗口及 Consumer 契约均不变，回滚只需恢复上一 Worker 版本。

## 测试计划

### 单元测试

- Payload、Queue Message、配置、GraphQL 响应和 AI 输出 Schema。
- 官方 Webhook 测试 Schema 接受包含普通 `https://cloudflare.com` URL 的完整官方标记，并拒绝任意文本与 Markdown 链接变体。
- 窗口计算、UTC 归一和 Consumer 窗口一致性校验。
- Normalizer、零分母与各比例 Statistics、阈值边界 Rules。
- AI Evidence 交叉校验、建议限制和降级状态。
- Formatter 必填字段、时区、长度控制、空数据与异常通知。
- 错误分类、重试判定和日志脱敏。
- WeCom Fetch `TypeError` 的安全分类，以及 timeout、network、运行时可识别的 DNS/TLS/connection 和 unknown 回退。
- 安全诊断摘要对哨兵 Webhook URL、Token、API Key 和 key 的替换、敏感 URL 清除与长度限制。

### Workers 集成测试

- 路由、方法、请求体大小、无效 Payload、受支持/不支持类型、Queue 入队失败和 `202` 时序。
- 官方测试 Payload 返回精确 `200` 响应，Queue 未调用且无 GraphQL、LLM、企业微信出站请求；普通文本和带 `text` 的畸形真实告警仍返回 `400`。
- Queue 延迟参数、固定消息窗口、晚到/重试消费不漂移。
- Fetch Mock 覆盖 GraphQL HTTP 200 + `errors`、timeout、429、5xx、永久错误和重试耗尽。
- LLM 成功、协议错误、Schema 错误、Evidence 越界及规则降级通知。
- WeCom 阶段内重试、成功后不重放、最终失败记录并确认且不重复上游分析。
- WeCom timeout、HTTP `4xx`/`429`/`5xx`、非法响应和非零 `errcode` 的稳定字段与规范化 `response_category`。
- GraphQL `collection_failed` 的具体 `errorCode` 进入最终 `notification_failed.snapshot_error_code`。
- `notification_failed` 被确认消费，且 GraphQL 和 LLM 调用次数保持一次，不因日志增强而重跑。
- 捕获日志并扫描 Token、API Key、Webhook URL、Authorization 和测试哨兵 Secret。

### 单环境验证

在人工准备单一 Queue、Cloudflare Token、LLM 中转站和企业微信机器人后，以脱敏 WAF Payload 完成一次端到端验证，并用同一窗口对照 Cloudflare Dashboard。记录 Worker/Queue 状态和日志关联字段。远端部署、Secret 写入与真实告警验证不属于自动执行范围。

## Risks / Trade-offs

- [Queue 至少一次可能产生重复通知] -> 固定 `incident_id`/`correlation_id` 并在通知显著展示；严格去重另立 Change。
- [Security Analytics 存在采样或聚合延迟] -> 固定延迟后做一次快照、展示窗口和口径，不声称覆盖完整事件生命周期。
- [未鉴权公网 Webhook 可被伪造或滥用] -> 严格 Schema、受支持类型、体积限制、快速拒绝和平台流量观测；入站鉴权作为后续独立安全 Change。
- [公开测试标记可被仿造] -> 测试分支只返回固定成功响应且没有 Queue、窗口或出站副作用；`cf-webhook-auth` 明确留待独立安全 Change。
- [多个 GraphQL 请求可能部分成功] -> 只有满足 Incident 最小数据契约才进入统计；否则发送采集失败通知，不拼接不可解释的部分结果。
- [AI Evidence 语义校验无法证明所有自然语言均正确] -> 限制字段与长度、验证关键实体和值、Formatter 分隔事实和推断；人工仍需根据 Evidence 决策。
- [Workers 执行预算限制短暂退避] -> 严格限制尝试次数、请求超时、样本和输出大小；在已部署 Worker 记录各阶段耗时。
- [成功通知后进程异常仍可能发生平台级重复] -> 避免应用主动抛错，但无持久化幂等时不能承诺 exactly-once。
- [Workers Runtime 不保证暴露可移植的 DNS/TLS/connection 细节] -> 仅在存在可靠信号时细分，否则稳定回退为 `network`，避免伪精确分类。
- [诊断文本可能携带 Credential 或敏感 URL] -> 优先记录稳定字段；可选摘要在分类边界和 Logger 两层脱敏并限制长度，测试使用哨兵敏感值验证无明文残留。

## Migration Plan

1. 初始化 npm/TypeScript/Workers/Vitest/ESLint 工程并锁定 `compatibility_date`。
2. 完成纯领域契约、配置、窗口和分析模块及单元测试。
3. 完成 Clients、Pipeline、Handlers 和 Workers 集成测试。
4. 运行 `npm run types`、`npm run typecheck`、`npm run lint`、`npm test` 和 Credential 扫描。
5. 本次可观测性修复和 Webhook 测试握手只在重新批准 artifacts 后实施和验证，不执行部署、Secret 写入、Cloudflare 资源变更或真实企业微信通知测试。
6. 后续如获得单独生产授权，再按发布检查清单部署；异常时通过部署上一已验证版本回滚，Queue Message 契约无需迁移。
