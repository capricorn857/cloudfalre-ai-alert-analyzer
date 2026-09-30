# 设计说明：优化 LLM 分析链路

## 总体方案

在现有 `LLMClient` 内建立“协议响应 -> 解析 -> LLM Schema -> Evidence”四阶段校验。响应 envelope 扩展 `finish_reason`、`refusal` 和可选 usage；每个阶段只生成稳定错误码和安全诊断摘要。错误摘要通过现有 `AppError` 传递给 AI Analyzer、Pipeline 和结构化 Logger，绝不携带 content、Prompt 或字段值。Evidence 失败额外归类为安全枚举 `unsupported_entity`、`automatic_action_claim` 或 `insufficient_data`，分类只反映命中的规则，不包含不受支持的实体或原始 Evidence 文本。

输出 token 配置加入 `BusinessConfigSchema`，由 `createProcessAlertDependencies` 注入 `LLMClient.maxOutputTokens`。`BUSINESS_CONFIG` 在 Wrangler 中显式写入 2048；Queue Message 与其它 timeout 保持原样。

LLM 请求由一个短退避、最多一次的 Client 内部 retry loop 包围，仅对 429/5xx 重试。每次尝试共享总耗时观测，最终错误仍由现有降级路径处理。为避免 Workers 预算失控，退避为固定短延迟且不对 transport timeout 或业务失败重试。

模型验证作为脱敏、人工运行的独立工具/记录流程，不被 Worker 启动或 Queue 消费调用；运行时仅使用 `LLM_MODEL`，不硬编码候选模型。

## 组件与边界

- `src/clients/llm.ts`：拥有 response schema、输出阶段分类、token 诊断和 HTTP retry；不做 Statistics、Evidence 规则以外的领域判断。
- `src/observability/errors.ts`：保留 `AppError` 公共字段，允许附加受控 LLM 诊断字段；Logger 继续统一脱敏。
- `src/analysis/ai-analyzer.ts`：消费错误码并构造规则降级，不解析底层异常文本。
- `src/config/env.ts` / `dependencies.ts`：验证并注入 `llmMaxOutputTokens`，不改变其它 Client 配置。
- `test/integration/llm-client.test.ts` 等：以 Fetch Mock 验证完整响应矩阵、调用次数和无原文日志。

## 数据与接口契约

请求继续发送固定的 `response_format.json_schema`、`strict: true` 和 `max_completion_tokens`；其中 Provider Schema 必须同步本地 Zod 的 `confidence` 数值范围、`summary` 长度、`evidence` 数量/项长度和 `recommendations` 数量/项长度。Queue Message、分析窗口、GraphQL 查询和通知契约不变。安全诊断字段为可选：`finish_reason`、`refusal_present`、`content_length`、`completion_tokens`、`reasoning_tokens`、`validation_stage`、`schema_issue_paths` 和 `evidence_failure_reason`。`schema_issue_paths` 只由 Zod issue path 转为字符串路径并限制长度/数量；`evidence_failure_reason` 仅允许 `unsupported_entity`、`automatic_action_claim`、`insufficient_data`。

## 错误处理

HTTP 429/500+ 进入一次内部 retry；400/401/403、timeout、network 以及所有输出阶段失败不在本 change 中额外重试。`finish_reason=length` 优先于内容解析；refusal 优先于内容解析。JSON 解析失败为 `llm_output_not_json`，Schema 为 `llm_output_schema_invalid`，Evidence 为 `ai_evidence_invalid` 并返回安全的 `evidence_failure_reason`。所有 LLM 失败均保留规则降级，且不触发 GraphQL 重查、Statistics 重算、Queue 重放或企业微信重复发送。

## 兼容与恢复

旧的 `llm_output_invalid` 不再由新输出阶段生成；调用方按 `AppError.code` 和可选诊断字段处理，未知错误仍按现有外部失败契约降级。Token usage 缺失时省略对应字段。失败重试耗尽后记录最终 HTTP 状态和总耗时。模型切换只通过已有 `LLM_MODEL` 变量，恢复方式为回滚配置或代码版本，不涉及线上资源变更。

## 测试计划

先在指定六组测试中写失败测试并确认失败原因，再实现最小修改：LLM 响应矩阵覆盖 stop/length/refusal/非 JSON/Markdown/Schema/枚举/confidence/recommendations/Evidence；HTTP 覆盖 429/503/400/401 与调用次数；配置覆盖默认、边界、越界和非整数；全链路覆盖规则降级、GraphQL/企业微信不重复调用；日志覆盖原文、Prompt、Token、Authorization、API Key、Webhook URL 不泄露。Evidence 测试必须分别验证三种安全失败原因，且诊断只记录枚举值。随后运行 types、typecheck、lint、test、OpenSpec 严格校验、工作流校验和 GitNexus。
