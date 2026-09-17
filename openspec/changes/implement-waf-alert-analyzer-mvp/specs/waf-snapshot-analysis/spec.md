## Purpose

定义 Queue Consumer 对固定窗口 WAF 告警执行一次性数据采集、标准化、确定性统计和规则分析的行为，并保证技术重试不会改变统计口径。

## ADDED Requirements

### Requirement: Queue message and window validation
Queue Consumer MUST 将消息作为不可信输入进行 Schema 校验，并 MUST 校验 `analysis_window.end = query_started_at`、窗口有序且与 Alert 时间和消息参数一致。Consumer SHALL 在开始处理时记录 `processing_started_at`，但 MUST NOT 使用该时间重算窗口。

#### Scenario: Valid fixed window
- **WHEN** Consumer 收到契约完整且窗口一致的 Queue Message
- **THEN** 系统记录 `processing_started_at` 并使用消息中的固定窗口继续处理

#### Scenario: Invalid queue message
- **WHEN** Queue Message 缺少字段、时间无效或窗口不一致
- **THEN** 系统将其分类为不可重试输入错误、记录脱敏日志且不调用任何外部分析 API

#### Scenario: Delayed or retried delivery
- **WHEN** Consumer 在 `query_started_at` 之后较晚启动或收到技术重试消息
- **THEN** 系统仍使用消息原有的 `analysis_window`，不以 `processing_started_at` 扩大窗口

### Requirement: Single snapshot collection
系统 SHALL 对每次有效消费执行一轮固定窗口数据采集；同一轮可以发起多个维度查询，但 MUST NOT 因数据增长、空数据或低事件量启动第二轮业务查询。

#### Scenario: Multi-dimensional collection
- **WHEN** WAF Analyzer 需要聚合和样本数据
- **THEN** 所有 GraphQL 请求均使用相同 `zone_tag` 和 `analysis_window`

#### Scenario: Events arrive after window end
- **WHEN** `analysis_window.end` 之后出现新的 Security Events
- **THEN** 本次分析不查询或纳入这些事件

#### Scenario: Empty snapshot
- **WHEN** 固定窗口查询返回零条事件
- **THEN** 系统生成数据不足结果而不延时轮询或重新计算窗口

### Requirement: Cloudflare GraphQL result contract
系统 MUST 查询并校验本次快照的 `total_events`、Top IP、Top Path、Top Host、Top Country、Top ASN、Action、Source 和受限样本。默认样本上限 SHALL 为 `50`，样本 SHALL 仅保留 `datetime`、`action`、`clientIP`、`clientCountryName`、`clientAsn`、`clientRequestHTTPHost`、`clientRequestPath`、`source` 和 `userAgent` 等允许字段。

#### Scenario: Successful GraphQL response
- **WHEN** Cloudflare 返回 HTTP 成功、无 GraphQL `errors` 且响应符合 Schema
- **THEN** 系统接受聚合和不超过 `sample_limit` 的样本数据

#### Scenario: HTTP 200 with GraphQL errors
- **WHEN** Cloudflare 返回 HTTP `200` 但响应包含 GraphQL `errors`
- **THEN** 系统将调用视为失败且不把部分原始响应作为成功数据

#### Scenario: Invalid GraphQL shape
- **WHEN** Cloudflare 响应不符合预期 Schema
- **THEN** 系统将调用视为不可用数据且不把未校验响应传入领域分析

### Requirement: Cloudflare API retry classification
系统 SHALL 仅对超时、`429` 和 `5xx` 等临时错误执行配置范围内的 1 至 2 次有限退避重试；鉴权、请求或 Schema 等非临时错误 MUST NOT 重试。所有尝试 MUST 复用固定窗口。

#### Scenario: Transient API recovery
- **WHEN** GraphQL 首次调用发生可重试错误且后续有限重试成功
- **THEN** 系统继续分析，且每次尝试的查询窗口完全相同

#### Scenario: Permanent API error
- **WHEN** GraphQL 返回不可重试错误
- **THEN** 系统停止 GraphQL 客户端重试并生成不含虚构结果的基础异常分析结果

#### Scenario: Retry exhaustion
- **WHEN** 所有有限重试均失败
- **THEN** 系统记录最终失败并转入基础异常通知路径，不调用 LLM 生成数据结论

### Requirement: Incident normalization
系统 MUST 将经过校验的 GraphQL 数据转换为 `Incident`，并 MUST NOT 向后续模块传递 Cloudflare 原始响应。`Incident` SHALL 包含 `incident_id`、Provider、告警类型、资源、告警时间、固定窗口、Payload 事件数参考值、GraphQL 指标、Evidence、受限样本和确定性 Findings 的承载位置。

#### Scenario: Normalize successful snapshot
- **WHEN** GraphQL 数据通过校验
- **THEN** 系统生成字段命名统一、时间为 UTC 且不含 Credential 的 `Incident`

#### Scenario: Preserve event count distinction
- **WHEN** Payload `events_count` 与 GraphQL `total_events` 不同
- **THEN** `Incident` 同时保留两者并将 GraphQL `total_events` 标识为比例统计分母

### Requirement: Deterministic statistics
系统 MUST 由程序基于 GraphQL `total_events` 计算 `Statistics`，至少包含事件总量、Top IP/Path/Country/ASN 集中度、`allow_ratio`、`block_ratio` 和 `challenge_ratio`。LLM MUST NOT 参与这些计算。

#### Scenario: Calculate ratios
- **WHEN** `total_events` 大于零
- **THEN** 各集中度和 Action 比例使用对应 Count 除以 `total_events` 计算并按统一精度展示

#### Scenario: Zero total events
- **WHEN** `total_events` 为零
- **THEN** 系统产生显式的数据不足统计，不输出 `NaN`、无穷值或虚构的百分比

#### Scenario: Aggregate does not equal total
- **WHEN** 某一维度的聚合计数之和因采样或分类口径与 `total_events` 不同
- **THEN** 系统仍使用 `total_events` 作为比例分母且不擅自补齐计数

### Requirement: Deterministic findings
系统 SHALL 在 AI 分析前根据经过校验的规则阈值生成 `Finding`。MVP SHALL 覆盖 IP、Path、Country、ASN、Allow、Block、User-Agent 集中度和请求速率；阈值 MUST 来自经过校验的配置而非业务代码中的散落常量。

#### Scenario: Threshold is crossed
- **WHEN** 某统计值达到配置的 `medium` 或 `high` 阈值
- **THEN** 系统生成包含类型、等级、数值和可引用 Evidence 的 Finding

#### Scenario: Threshold is not crossed
- **WHEN** 某统计值低于所有配置阈值
- **THEN** 系统不为该规则生成夸大的风险 Finding

#### Scenario: Insufficient data for a rule
- **WHEN** 规则所需分母或样本字段不可用
- **THEN** 系统将该规则结果标记为数据不足而不推断数值
