---
status: approved
---

# 变更提案：实现 Cloudflare WAF 告警分析 MVP

## 背景

Cloudflare 现有 WAF 告警只能说明异常已经发生，运维和安全人员仍需手工进入 Dashboard 还原攻击来源、目标、防护效果和风险。项目需要在 Cloudflare Workers 上建立一条只读、可降级、可追溯的自动分析链路，把有效告警转换为可直接用于初步研判的企业微信通知。

生产验收已确认 Webhook、Queue producer、Consumer 和固定分析窗口正常，但外部 API 失败日志不足以定位故障：底层 Fetch 异常会被统一改写而丢失 timeout、network 及运行时可识别的 DNS/TLS/connection 信息，GraphQL 采集失败的具体错误码也未进入最终通知失败日志。需要在不改变现有处理语义的前提下补齐稳定、可查询且安全脱敏的外部依赖失败观测契约。

Cloudflare Generic Webhook 在创建目的地时会向同一路由发送仅含官方测试文案的 JSON 请求。当前入口在 JSON 解析后直接执行真实 WAF Payload Schema 校验，因此该测试请求被返回 `400 Invalid Cloudflare alert payload`，导致 “Save and Test” 无法完成。系统需要在保持真实告警严格校验、固定窗口和 Queue 行为不变的前提下，识别并无副作用地接受这一官方测试握手。

## 目标

- 初始化基于 TypeScript、Cloudflare Workers、Cloudflare Queues、Zod、Wrangler、Vitest 和 ESLint 的 MVP 工程。
- 提供公开接收、经过 Schema 校验和告警类型过滤的 Cloudflare WAF Webhook，并将内部 Alert 延迟写入 Queue 后返回 `202 Accepted`。
- 在 JSON 解析后、真实 WAF Payload 校验前，使用独立 Schema 识别包含 Cloudflare 官方测试标记的 Generic Webhook 测试请求，并返回 `200` 与 `{"message":"Webhook test accepted"}`。
- 在入队时按照 `query_started_at = webhook_received_at + settle_seconds` 固定逻辑查询时间和 `analysis_window`；Queue Consumer 另行记录仅用于观测的 `processing_started_at`，所有重试复用同一快照窗口。
- 查询 Cloudflare GraphQL Security Analytics，标准化 Incident，并由程序计算 Statistics 和确定性 Findings。
- 调用兼容 OpenAI HTTP 接口生成结构化 AI 分析；调用失败或输出无效时降级为规则分析。
- 格式化并发送企业微信通知，展示分析窗口、事实、结论、建议、`incident_id` 和 `correlation_id`。
- 增加有限重试、错误分类、结构化脱敏日志、Workers Runtime 测试和单环境端到端验收流程。
- 为外部 API 失败定义稳定、可查询的日志字段，至少包含 `external_service`、`error_code`、`failure_kind`、`retryable` 和 `duration_ms`；HTTP 失败补充 `http_status`，GraphQL 采集失败补充 `snapshot_error_code`。
- 区分 timeout、network、运行时可识别的 DNS/TLS/connection 和 unknown Fetch 失败；企业微信响应只记录规范化结果类别，不记录原始响应。
- 如保留异常名称或消息用于诊断，统一执行 Secret 替换、敏感 URL 清除和长度限制，并以包含哨兵敏感值的自动化测试验证。
- 准备单套 Worker/Queue 的发布检查清单和人工门禁，但不创建远端资源、不写入真实 Secret，也不执行部署。

## 非目标

- 不建设 Web 管理后台、权限系统、历史检索、持续事件跟踪或初报/终报机制。
- 不自动封禁 IP，不修改 WAF、Rate Limit 或其他 Cloudflare 配置。
- 不引入数据库、D1、KV、Durable Objects、R2、Workflows、第三方队列、容器或自建服务器。
- 不引入代理、中转服务或新的 SDK，不改变 Queue 固定窗口、有限重试和至少一次投递语义。
- 不因企业微信最终失败重新执行 GraphQL、统计、规则或 AI 分析。
- 不将任意 `{"text":"..."}` 视为官方测试请求，不放宽真实 WAF Payload Schema，也不在本次修复中实现 `cf-webhook-auth`。
- 不在本 Change 中创建远端资源、写入真实 Secret 或执行远端部署。

## Capabilities

### New Capabilities

- `cloudflare-alert-ingestion`: Webhook 路由、Payload 校验、WAF 告警过滤与映射、固定窗口消息构造和 Queue 入队。
- `waf-snapshot-analysis`: Queue 消费、固定窗口 GraphQL 数据采集、采集错误码传播、Incident 标准化、统计和确定性规则分析。
- `ai-assisted-analysis`: 受 Evidence 约束的结构化 AI 分析，以及 LLM 不可用时的规则降级。
- `wecom-alert-notification`: 使用已校验领域数据生成固定格式通知，可靠发送到企业微信机器人，并区分 Fetch、HTTP、协议和业务响应失败。
- `worker-operations`: 配置校验、稳定外部错误字段、安全诊断摘要、有限重试、日志脱敏、单环境配置和部署验证要求。

### Modified Capabilities

无。

## 影响范围

- 新增 `src/` 与 `test/` 下的 Worker 应用、领域模块、外部客户端、分析逻辑和测试夹具。
- 新增 npm 工具链、单 Worker/Queue 及 Queue producer/consumer bindings 配置。
- 新增对 Cloudflare GraphQL、兼容 OpenAI 的 LLM API 和企业微信 Webhook 的出站请求。
- 可观测性修复影响 `src/clients/` 的外部失败分类、`src/pipeline/` 的错误上下文传播、`src/observability/` 的结构化日志与脱敏，以及对应单元和 Workers 集成测试；不改变外部 HTTP API、Queue Message 或基础设施契约。
- Webhook 测试握手影响 `src/domain/alert.ts` 的边界 Schema、`src/api/cloudflare-alert.ts` 的 JSON 解析后分支和 `test/integration/cloudflare-alert-route.test.ts`；不改变 Queue Message、固定窗口或下游分析契约。
- 需要三项 Workers Secrets：`CLOUDFLARE_API_TOKEN`、`LLM_API_KEY`、`WECOM_WEBHOOK_URL`；MVP 不配置入站 Webhook Secret。
- 未鉴权的公网 Webhook 存在伪造请求和 Queue 滥用风险，MVP 通过严格 Payload 校验、受支持告警类型过滤、请求体大小限制和平台侧流量观测降低风险。
- MVP 不引入数据库、持久化幂等、DLQ、Workflows、自建服务器或自动 Cloudflare 配置变更。

## 风险与兼容性

- Cloudflare Queue 为至少一次投递，极端情况下可能重复通知；MVP 通过稳定的 `incident_id` 和 `correlation_id` 支持人工识别，不承诺 exactly-once。
- Security Analytics 可能存在采样或聚合延迟；系统固定延迟后只执行一次快照，并展示分析窗口与统计口径。
- 公网 Webhook 在 MVP 不配置入站 Secret；通过严格 Schema、请求体限制、类型过滤和平台流量观测降低滥用风险。
- 测试握手分支只接受 `text` 包含完整官方标记 `This is a test message sent from [https://cloudflare.com](https://cloudflare.com).` 的合法 JSON；其他任意文本、畸形 JSON 和缺少真实告警字段的 Payload 仍返回 `400`。
- 首次实现没有历史应用数据迁移；Queue Message 使用显式版本，未来破坏性变更需保持 Consumer 兼容。
- 单环境配置降低部署复杂度，但不提供 staging 隔离；所有远端变更必须依赖发布前检查、人工授权和可回滚版本控制。

## 验收标准

- 有效 WAF Payload 成功固定窗口并入队后返回 `202`；无效 Payload 和入队失败不得返回成功。
- Cloudflare 官方 Generic Webhook 测试 Payload 返回 `200` 和 `{"message":"Webhook test accepted"}`，且不写入 Queue、不计算分析窗口、不调用 GraphQL、LLM 或企业微信。
- 任意 `{"text":"hello"}`、畸形 JSON 以及带 `text` 但缺少必需字段的畸形真实告警仍返回 `400`；原有有效告警、无效告警和 Queue 失败行为保持不变。
- Consumer 的首次处理与技术重试使用完全相同的 `analysis_window`，且每次正常消费只进行一轮业务快照采集。
- Top IP、Path、Country、ASN 和 Action 比例使用 GraphQL `total_events`，可用相同窗口在 Dashboard 核验或解释差异。
- AI 结果通过结构与 Evidence 校验；LLM 失败时仍发送包含 Statistics 和 Findings 的降级通知。
- 企业微信通知展示窗口、身份标识、事实、结论和建议，发送成功后不得由应用主动触发 Queue 重试。
- 外部 API 最终失败日志至少包含 `external_service`、`error_code`、`failure_kind`、`retryable` 和 `duration_ms`；HTTP 错误包含 `http_status`，GraphQL 采集失败包含 `snapshot_error_code`。
- 企业微信 timeout、network、运行时可识别的 DNS/TLS/connection、unknown Fetch 异常，以及 HTTP `4xx`/`429`/`5xx`、非法响应和非零 `errcode` 均映射到稳定分类；日志只记录规范化响应类别，不记录原始响应。
- 当异常名称或消息包含哨兵 Webhook URL、Token、API Key 或 key 时，日志中不得出现任何对应明文，且诊断文本经过长度限制。
- 企业微信最终失败仍确认 Queue Message，且不重新执行 GraphQL、统计、规则或 AI 分析；LLM 失败仍按既有规则降级。
- `npm run types`、`npm run typecheck`、`npm run lint`、`npm test`、OpenSpec 严格校验与 Credential 扫描通过。
