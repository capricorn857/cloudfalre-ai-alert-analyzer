## Purpose

定义 Cloudflare WAF Webhook 的接收、校验、类型映射、固定快照窗口和 Queue 入队行为，使有效告警能够快速、可追溯地进入异步分析链路。

## ADDED Requirements

### Requirement: Webhook route and method
系统 SHALL 在 `POST /api/v1/alerts/cloudflare` 接收 Cloudflare 告警，并 SHALL 拒绝其他路由或 HTTP 方法。

#### Scenario: Supported request route
- **WHEN** 调用方对 `/api/v1/alerts/cloudflare` 发起 `POST` 请求
- **THEN** 系统进入 Cloudflare 告警 Payload 校验流程

#### Scenario: Unsupported route
- **WHEN** 请求路径不是 `/api/v1/alerts/cloudflare`
- **THEN** 系统返回 `404 Not Found` 且不写入 Queue

#### Scenario: Unsupported method
- **WHEN** 对受支持路径使用 `POST` 之外的 HTTP 方法
- **THEN** 系统返回 `405 Method Not Allowed` 且不写入 Queue

### Requirement: Payload boundary validation
系统 MUST 将请求体作为不可信输入进行解析和 Schema 校验。有效 Payload MUST 至少包含 `zone_name`、`zone_tag`、带时区的 `alert_start_time`、`events_count`、`alert_type`、`alert_event` 和 `alert_correlation_id`；存在时 SHALL 保留 `dashboard_link`。系统 MUST 对请求体大小设置明确上限。

#### Scenario: Valid WAF payload
- **WHEN** 请求体在大小上限内、是合法 JSON 且包含所有必需字段
- **THEN** 系统生成经过校验的 `CloudflareAlertPayload`

#### Scenario: Malformed JSON
- **WHEN** 请求体不是合法 JSON
- **THEN** 系统返回 `400 Bad Request`、记录脱敏的输入错误且不写入 Queue

#### Scenario: Missing required field
- **WHEN** Payload 缺少 `zone_tag`、`alert_start_time` 或任一必需字段
- **THEN** 系统返回 `400 Bad Request`、记录脱敏的输入错误且不写入 Queue

#### Scenario: Invalid timestamp
- **WHEN** `alert_start_time` 不是带时区的 ISO 8601 时间
- **THEN** 系统返回 `400 Bad Request` 且不写入 Queue

#### Scenario: Request body exceeds limit
- **WHEN** 请求体超过配置的大小上限
- **THEN** 系统返回 `413 Payload Too Large` 且不解析或写入 Queue

### Requirement: Cloudflare Generic Webhook test handshake
系统 MUST 在请求体完成 JSON 解析后、真实 WAF Payload Schema 校验前，使用独立 Schema 识别 Cloudflare Generic Webhook 官方测试请求。测试请求的 `text` MUST 包含完整标记 `This is a test message sent from https://cloudflare.com.`；系统 MUST NOT 将任意包含 `text` 的对象或 Markdown 链接变体视为测试成功。

#### Scenario: Official Cloudflare webhook test is accepted
- **WHEN** 合法 JSON 的 `text` 包含完整 Cloudflare 官方测试标记
- **THEN** 系统返回 `200 OK` 和精确 JSON 响应 `{"message":"Webhook test accepted"}`
- **AND** 系统不写入 Queue、不计算 `query_started_at` 或 `analysis_window`，也不调用 Cloudflare GraphQL、LLM 或企业微信

#### Scenario: Arbitrary text is rejected
- **WHEN** 请求体为 `{"text":"hello"}` 或其他不包含完整官方测试标记的文本对象
- **THEN** 系统返回 `400 Bad Request` 且不写入 Queue 或调用任何下游服务

#### Scenario: Markdown link variant is rejected
- **WHEN** `text` 仅包含 `This is a test message sent from [https://cloudflare.com](https://cloudflare.com).` 而不包含官方普通 URL 标记
- **THEN** 系统返回 `400 Bad Request` 且不写入 Queue 或调用任何下游服务

#### Scenario: Text does not bypass malformed alert validation
- **WHEN** Payload 带有 `text` 但不满足官方测试标记，并且缺少真实 WAF 告警必需字段
- **THEN** 系统返回 `400 Bad Request` 且不写入 Queue 或调用任何下游服务

### Requirement: Supported alert mapping
系统 SHALL 仅将 `alert_type = clickhouse_alert_fw_anomaly` 的告警映射为内部 `Alert.alertType = waf_attack`。MVP 不支持的告警类型 MUST NOT 进入分析 Queue。

#### Scenario: Supported WAF anomaly
- **WHEN** 经过校验的 Payload 的 `alert_type` 为 `clickhouse_alert_fw_anomaly`
- **THEN** 系统构造包含资源、告警时间、关联标识和 Payload 事件数参考值的内部 `Alert`

#### Scenario: Unsupported alert type
- **WHEN** 经过校验的 Payload 的 `alert_type` 不受 MVP 支持
- **THEN** 系统返回 `202 Accepted`、记录 `unsupported_alert_type` 且不写入 Queue

### Requirement: Fixed snapshot window construction
系统 MUST 在 Payload 通过校验且准备入队时记录 `webhook_received_at`，并使用同一次配置快照计算 `query_started_at = webhook_received_at + settle_seconds`、`analysis_window.start = alert_time - before_minutes` 和 `analysis_window.end = query_started_at`。默认 `before_minutes` SHALL 为 `30`，默认 `settle_seconds` SHALL 为 `60`。

#### Scenario: Default snapshot window
- **WHEN** 有效告警使用默认业务参数入队
- **THEN** Queue Message 中的窗口开始时间比 `alert_time` 早 30 分钟，窗口结束时间比 `webhook_received_at` 晚 60 秒

#### Scenario: Configured snapshot window
- **WHEN** `before_minutes` 或 `settle_seconds` 被配置为有效的非默认值
- **THEN** 系统按该配置计算一次窗口并将结果写入 Queue Message

#### Scenario: UTC normalization
- **WHEN** 输入时间包含任意合法时区偏移
- **THEN** Queue Message 中所有时间均为表示同一时刻的 UTC ISO 8601 字符串

### Requirement: Queue message contract
系统 MUST 在入队前校验 Queue Message。消息 SHALL 包含 `Alert`、`incident_id`、`correlation_id`、`webhook_received_at`、`query_started_at` 和固定的 `analysis_window`，且重试所需的信息 MUST 全部包含在消息中。

#### Scenario: Valid message is delayed
- **WHEN** 系统构造出有效 Queue Message
- **THEN** 系统以 `settle_seconds` 作为投递延迟将消息发送到分析 Queue

#### Scenario: Invalid internal message
- **WHEN** 构造出的 Queue Message 未通过内部 Schema 校验
- **THEN** 系统不发送消息、不返回成功入队结果并记录不可重试的内部契约错误

### Requirement: Acceptance follows durable enqueue
系统 SHALL 仅在 Queue 写入成功后对受支持告警返回 `202 Accepted`。Webhook Handler MUST NOT 调用 Cloudflare GraphQL、LLM 或企业微信。

#### Scenario: Successful enqueue
- **WHEN** 受支持的有效告警已成功写入 Queue
- **THEN** 系统返回 `202 Accepted`，响应不等待后续分析完成

#### Scenario: Queue enqueue failure
- **WHEN** Queue 写入失败
- **THEN** 系统返回 `5xx`、记录可重试错误且不声称告警已被接受

#### Scenario: Ingestion has no downstream calls
- **WHEN** Webhook Handler 处理任意请求
- **THEN** 该请求生命周期内不会调用 Cloudflare GraphQL、LLM 或企业微信端点
