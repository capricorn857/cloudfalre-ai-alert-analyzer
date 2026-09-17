## Purpose

定义将经过校验的告警事实、统计、规则 Findings 和可选 AI 结果格式化为一致、可追溯的企业微信通知，并隔离发送重试与上游分析。

## ADDED Requirements

### Requirement: Formatter-owned message
企业微信消息 MUST 由 Formatter 基于经过校验的领域数据生成，不得直接发送 LLM 原始文本。事实区域 SHALL 来自 `Incident` 和 `Statistics`，AI 区域 SHALL 仅使用经过校验的 `AIAnalysis` 或明确的规则降级内容。

#### Scenario: AI analysis available
- **WHEN** 存在有效 `AIAnalysis`
- **THEN** Formatter 将事实数据与 AI 摘要、Evidence 和建议分区展示

#### Scenario: AI analysis unavailable
- **WHEN** LLM 调用或输出校验失败
- **THEN** Formatter 使用 Statistics 和 Findings 生成基础分析并显示 `AI 分析暂不可用`

#### Scenario: Raw model text exists
- **WHEN** LLM 客户端保留了未校验的原始响应用于错误分类
- **THEN** Formatter 无法访问或发送该原始响应

### Requirement: Required notification content
正常快照通知 SHALL 至少展示域名、告警时间、分析窗口及数据截至时间、GraphQL 事件总量、Payload 事件数参考值、风险等级或降级状态、Top IP、Top Country、Top ASN、Top Path、Cloudflare Action、摘要、Evidence、最多 3 条建议、Dashboard Link、`incident_id` 和 `correlation_id`。

#### Scenario: Complete snapshot notification
- **WHEN** 快照数据和 AI 分析均可用
- **THEN** 通知包含所有必需字段，比例基于 GraphQL `total_events`

#### Scenario: Payload and GraphQL counts differ
- **WHEN** Payload 事件数与 GraphQL `total_events` 不同
- **THEN** 通知区分参考告警数和快照统计数，不暗示两者必须相等

#### Scenario: Timezone presentation
- **WHEN** Formatter 展示告警时间或分析窗口
- **THEN** 通知使用配置的展示时区并明确标识时区，内部 UTC 值的含义不改变

### Requirement: Empty and collection-failure messages
数据为空或 Cloudflare 数据采集最终失败时，系统 SHALL 发送不包含虚构统计和 AI 结论的基础通知。

#### Scenario: Empty snapshot data
- **WHEN** 固定窗口内 `total_events` 为零
- **THEN** 通知明确说明当前分析窗口未查询到足够 Security Events 数据并展示固定窗口

#### Scenario: Cloudflare collection fails
- **WHEN** Cloudflare API 有限重试后仍失败
- **THEN** 通知展示告警基本信息、窗口和数据采集失败状态，不展示伪造的 Top 列表或 AI 判断

### Requirement: Message length control
Formatter MUST 对列表数量、单字段长度和总消息长度实施确定性限制，同时优先保留身份标识、窗口、关键事实、降级状态和处置建议。

#### Scenario: Large evidence set
- **WHEN** Incident 包含接近上限的样本和多个聚合项
- **THEN** 通知仅展示受限 Top 项并保持在企业微信消息限制内

#### Scenario: Long AI text
- **WHEN** 经过校验的 AI 字段仍超过 Formatter 的展示上限
- **THEN** Formatter 确定性截断非关键文本且不删除 `incident_id`、`correlation_id` 或分析窗口

### Requirement: Isolated WeCom retries
企业微信客户端 SHALL 仅对超时、`429` 和 `5xx` 等临时错误执行配置范围内的 1 至 2 次有限退避重试。通知重试 MUST 复用已格式化的消息，且 MUST NOT 触发 GraphQL 重查、统计重算或 LLM 重试。

#### Scenario: Transient send recovery
- **WHEN** 首次企业微信发送发生临时错误且有限重试成功
- **THEN** 系统确认通知成功并结束本次消费

#### Scenario: Permanent send error
- **WHEN** 企业微信返回不可重试错误
- **THEN** 系统停止客户端重试、记录通知失败并确认 Queue Message，不重新执行 GraphQL 或 AI 分析

#### Scenario: Retry exhaustion
- **WHEN** 企业微信有限重试全部失败
- **THEN** 系统记录最终失败、确认 Queue Message，且所有尝试发送完全相同的已格式化消息

### Requirement: Post-send acknowledgement safety
一旦企业微信确认发送成功，系统 MUST 将消息视为已完成并 MUST NOT 再抛出会导致 Queue 重试的异常。

#### Scenario: Logging fails after successful send
- **WHEN** 企业微信已成功返回但后续非关键观测操作失败
- **THEN** 系统保留发送成功结果并确认 Queue Message，不造成重复通知

#### Scenario: Successful delivery
- **WHEN** 企业微信确认接收消息
- **THEN** Consumer 确认本次 Queue Message 已完成
