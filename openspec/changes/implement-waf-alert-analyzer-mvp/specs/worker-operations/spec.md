## Purpose

定义 Worker 的配置、安全、日志、单环境 Queue 语义和部署验证要求，使 MVP 可在不泄漏 Credential 或执行未授权远端变更的前提下运行。

## ADDED Requirements

### Requirement: Validated runtime configuration
系统 MUST 使用 Schema 校验 Workers Secrets、Wrangler vars 和业务参数。必需 Secrets SHALL 为 `CLOUDFLARE_API_TOKEN`、`LLM_API_KEY` 和 `WECOM_WEBHOOK_URL`；非敏感 vars SHALL 包含 `LLM_BASE_URL`、`LLM_MODEL` 和业务配置。无效配置 MUST 快速失败且不得输出 Secret 值。

#### Scenario: Valid configuration
- **WHEN** 所有必需配置存在且符合约束
- **THEN** 系统生成只读的运行时配置供本次请求或消费使用

#### Scenario: Missing secret
- **WHEN** 任一必需 Secret 缺失
- **THEN** 系统停止相关处理、记录脱敏的 `config_invalid` 错误且不调用外部 API

#### Scenario: Invalid business parameters
- **WHEN** 时间窗口、样本上限、超时、重试或规则阈值不符合允许范围
- **THEN** 系统拒绝配置而不使用隐式或危险值继续处理

### Requirement: Structured redacted logging
系统 SHALL 输出单行 JSON 日志，并按阶段包含可用的 `incident_id`、`correlation_id`、告警类型、资源、告警时间、`analysis_window`、`query_started_at`、`processing_started_at`、`queue_attempt` 和外部 API 状态。每个外部依赖最终失败日志 MUST 包含取值为 `cloudflare`、`llm` 或 `wecom` 的 `external_service`，以及稳定的 `error_code`、`failure_kind`、`retryable` 和非负有限数值 `duration_ms`。HTTP 失败 MUST 额外包含 `http_status`；GraphQL 采集失败进入最终处理日志时 MUST 包含 `snapshot_error_code`；企业微信响应只能记录规范化 `response_category`，不得记录原始响应。日志 MUST 对 Credential、Authorization Header、Token、API Key、Webhook URL、Webhook key、过长请求和外部错误响应进行删除、截断或脱敏。

#### Scenario: Successful processing log
- **WHEN** 一条告警完成通知
- **THEN** 日志可通过 `incident_id` 和 `correlation_id` 关联主要阶段且不包含 Credential

#### Scenario: External API error log
- **WHEN** 任一外部 API 返回错误
- **THEN** 最终失败日志记录 `external_service`、`error_code`、`failure_kind`、`retryable` 和 `duration_ms`，仅在适用时记录协议专用字段，且不记录 Authorization Header、响应 Header 或大型原始响应

#### Scenario: HTTP dependency failure
- **WHEN** 任一外部 API 返回非成功 HTTP 状态
- **THEN** 日志记录 `failure_kind=http` 和实际 `http_status`，且不记录响应 Header 或原始响应体

#### Scenario: Secret-like data in error
- **WHEN** 上游异常名称、消息、cause 或 URL 含有哨兵 Webhook URL、Token、API Key、Authorization 或 key
- **THEN** 结构化日志在写入前完成已知 Secret 替换、敏感 URL 和 query 清除及长度限制，输出中不存在对应明文、原始异常对象或原始响应

### Requirement: Explicit error taxonomy
系统 MUST 区分输入错误、不可重试错误、可重试错误、AI 降级、通知失败和已成功发送后的非关键错误，并据此决定响应、重试、降级或确认消息。外部依赖失败的 `failure_kind` MUST 为 `timeout`、`network`、`dns`、`tls`、`connection`、`http`、`invalid_response`、`service_error` 或 `unknown` 之一。

#### Scenario: Invalid external input
- **WHEN** Webhook 或 Queue Message Schema 校验失败
- **THEN** 系统记录输入错误且不进行无意义的技术重试

#### Scenario: Transient dependency failure
- **WHEN** 外部依赖发生被分类为临时的错误
- **THEN** 系统仅在该阶段执行有限客户端重试或按明确 Queue 策略重试

#### Scenario: Fetch transport failure
- **WHEN** Fetch 抛出 timeout、`TypeError` 或运行时暴露可识别的 DNS、TLS 或连接失败信号
- **THEN** 系统分别记录 `timeout`、`network` 或可可靠识别的 `dns`、`tls`、`connection`，且在缺少可靠信号时不得猜测更具体类别

#### Scenario: Unknown dependency failure
- **WHEN** 外部调用抛出无法识别且不属于 HTTP 或协议响应的异常
- **THEN** 系统稳定回退为 `failure_kind=unknown`，并仍记录 `external_service`、`error_code`、`retryable` 和 `duration_ms`

#### Scenario: AI degradation
- **WHEN** LLM 失败或输出无效
- **THEN** 系统记录独立的 AI 降级状态并继续通知，不将其分类为整条消息失败

### Requirement: At-least-once queue semantics
系统 SHALL 将 Cloudflare Queue 视为至少一次投递。MVP MUST 使用 `max_batch_size = 1`，技术重试 SHALL 保留首次确定的消息、身份标识和窗口。MVP SHALL 通过通知中的 `incident_id` 与 `correlation_id` 支持人工识别重复，而不得声称 exactly-once。

#### Scenario: Duplicate delivery
- **WHEN** Queue 重复投递同一消息
- **THEN** 每次处理均保留相同 `incident_id`、`correlation_id` 和固定窗口，通知可被识别为同一事件

#### Scenario: Consumer infrastructure retry
- **WHEN** Consumer 因基础设施异常由 Queue 重试
- **THEN** 重试消息不重新计算 `query_started_at` 或 `analysis_window`

### Requirement: Read-only security posture
系统 MUST NOT 创建、修改或删除 Cloudflare WAF、Rate Limit、IP List 或其他生产配置，也 MUST NOT 将 LLM 建议作为可执行操作。

#### Scenario: Analysis recommends a change
- **WHEN** Findings 或 AI 建议检查 Rate Limit、WAF Rule 或 IP
- **THEN** 通知仅将其呈现为人工建议且系统不调用任何配置写 API

#### Scenario: Runtime credentials
- **WHEN** Worker 调用 Cloudflare GraphQL
- **THEN** 凭证仅用于只读数据请求且不会被持久化到应用数据

### Requirement: Single runtime environment
系统 SHALL 使用一套名为 `cloudflare-ai-alert-analyzer` 的 Worker、Queue 和运行时配置，不再维护 staging/production Wrangler environments。测试和本地开发 MUST 使用虚构或脱敏数据，且 MUST NOT 调用已部署 Worker 使用的真实企业微信机器人。

#### Scenario: Single environment configuration
- **WHEN** 生成类型、本地运行或部署 Worker
- **THEN** Wrangler 使用顶层 Worker、Queue、vars 和 Secret bindings，不要求 `--env` 参数

#### Scenario: Dashboard-managed LLM relay configuration
- **WHEN** Worker 调用 OpenAI 兼容中转站
- **THEN** `LLM_BASE_URL` 和 `LLM_MODEL` 从 Worker Dashboard 的普通 Text 变量读取，三个 Credential 从 Secret 变量读取

#### Scenario: Local automated test
- **WHEN** 执行单元或 Workers 集成测试
- **THEN** 外部调用由 Mock 或明确的测试端点承接且夹具不含真实 Credential

### Requirement: Verification and deployment gates
工程 SHALL 提供 `npm run dev`、`npm run types`、`npm run typecheck`、`npm run lint`、`npm test` 和 `npm run deploy`。部署前 MUST 完成依赖安装、类型检查、Lint、测试、Wrangler 配置校验和端到端验证。远端部署和 Secret 写入 MUST 由用户明确授权。

#### Scenario: Pre-deployment validation
- **WHEN** 准备部署 Worker
- **THEN** 类型检查、Lint、测试和 Wrangler 配置校验均成功后才允许继续

#### Scenario: End-to-end validation
- **WHEN** 单套远端资源和运行时配置已由人工准备
- **THEN** 验证 Webhook Route、Queue producer、Queue consumer、Secrets、外部 Fetch 和 Workers Logs 的完整链路

#### Scenario: No remote authorization
- **WHEN** 未收到明确的远端部署或 Secret 写入指令
- **THEN** 实施过程止于配置与检查清单，不执行对应远端操作
