## Purpose

定义以 Incident、程序计算 Statistics 和 Findings 为唯一事实输入的结构化 AI 安全分析，以及 LLM 不可用或证据不足时可验证的降级行为。

## ADDED Requirements

### Requirement: Bounded AI input
系统 SHALL 仅向 LLM 提交经过校验和裁剪的 `Incident`、`Statistics` 与 `Findings`。输入 MUST NOT 包含 Credential、Cloudflare 原始响应、完整原始 Payload 或让模型查询 Cloudflare、重算统计和执行配置变更的能力。

#### Scenario: Build AI request
- **WHEN** 快照分析产生有效 Incident、Statistics 和 Findings
- **THEN** LLM 请求只包含这些允许的结构化数据和明确的输出约束

#### Scenario: Cloudflare data unavailable
- **WHEN** Cloudflare 数据采集最终失败
- **THEN** 系统不调用 LLM 编造数据结论并直接进入基础异常通知路径

### Requirement: Structured AI output
LLM 输出 MUST 解析为 JSON 并通过 `AIAnalysis` Schema 校验。结果 SHALL 包含 `risk_level`、`attack_type`、`confidence`、`summary`、`evidence` 和最多 3 条 `recommendations`；`risk_level` SHALL 限于 `LOW`、`MEDIUM`、`HIGH`、`CRITICAL`。

#### Scenario: Valid structured response
- **WHEN** LLM 返回符合 Schema 的结构化 JSON
- **THEN** 系统接受并生成经过校验的 `AIAnalysis`

#### Scenario: Non-JSON response
- **WHEN** LLM 返回自然语言、Markdown 包裹或无法解析的内容
- **THEN** 系统拒绝该输出并执行 AI 降级

#### Scenario: Schema-invalid response
- **WHEN** LLM JSON 缺少必需字段、枚举非法、置信度越界或建议超过 3 条
- **THEN** 系统拒绝该输出并执行 AI 降级

### Requirement: Evidence traceability
系统 MUST 要求 AI 的攻击类型、风险和摘要结论映射到输入 Evidence。AI 不得引入输入中不存在的 IP、Path、Country、ASN、Count 或 Action；证据不足时 `attack_type` MUST 为 `Unknown` 且摘要 SHALL 明确证据不足。

#### Scenario: Evidence-supported assessment
- **WHEN** AI 结论引用输入中的统计或 Finding
- **THEN** 输出 Evidence 可对应到相同的事实字段和值

#### Scenario: Unsupported factual claim
- **WHEN** AI 输出引用输入中不存在的关键事实
- **THEN** 系统将结果视为无效并执行 AI 降级，不向通知发送该原始输出

#### Scenario: Insufficient evidence
- **WHEN** 输入不足以支持具体攻击类型
- **THEN** 有效 AI 输出将攻击类型设为 `Unknown` 并说明证据不足

### Requirement: Advisory-only recommendations
AI 建议 SHALL 最多 3 条，并 SHALL 仅描述人工核验或建议性处置，不得表示系统已经或将自动修改 Cloudflare 配置。

#### Scenario: Valid recommendations
- **WHEN** AI 返回建议
- **THEN** 每条建议均为人工可评估的检查或处置建议且总数不超过 3

#### Scenario: Automatic action claim
- **WHEN** AI 输出声称已封禁 IP、已修改 WAF 或将自动执行生产变更
- **THEN** 系统拒绝该输出并执行 AI 降级

### Requirement: AI failure isolation
LLM 超时、网络错误、HTTP 错误、响应解析失败或 Schema 校验失败 MUST NOT 导致告警丢失或整条 Queue Message 因 AI 原因重放。系统 SHALL 使用 Statistics 和 Findings 生成规则降级结果，并明确标记 `AI 分析暂不可用`。

#### Scenario: LLM request fails
- **WHEN** LLM 调用因任一技术错误失败
- **THEN** 系统继续通知流程并使用规则降级分析

#### Scenario: LLM output validation fails
- **WHEN** LLM 返回内容未通过结构或证据校验
- **THEN** 系统丢弃原始输出、记录 AI 降级状态并继续通知流程

#### Scenario: AI failure does not replay collection
- **WHEN** 系统执行 AI 降级
- **THEN** 不重新查询 Cloudflare、不重算窗口且不因该失败请求 Queue 重试
