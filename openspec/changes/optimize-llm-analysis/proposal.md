---
status: implemented
---

# 变更提案：优化 LLM 分析链路

## 背景

当前 LLM 客户端把非 JSON、Schema 失败和 Evidence 失败统一记录为 `llm_output_invalid`，无法解释 HTTP 200 下的输出失败；同时没有检查 `finish_reason` 或 `message.refusal`，诊断日志缺少 token、内容长度和安全字段路径。输出 token 上限仍在依赖组装处固定为 800，且 429/5xx 直接进入规则降级。现有 Worker 已有固定快照和规则降级边界，本变更只优化 LLM 阶段。

## 目标

- 将 LLM 输出失败拆分为 `llm_output_not_json`、`llm_output_schema_invalid`、`llm_output_truncated`、`llm_refused` 和 `ai_evidence_invalid`。
- 记录不含原文、Prompt、Token、Authorization、API Key 或 Webhook URL 的安全诊断字段：`finish_reason`、`refusal_present`、`content_length`、`completion_tokens`、`reasoning_tokens`、`validation_stage` 和 `schema_issue_paths`。
- 增加 `BUSINESS_CONFIG.llmMaxOutputTokens`，默认 2048，允许 512 至 8192 的整数覆盖，并替换固定的 `max_completion_tokens=800`。
- 在 LLM Client 内对 HTTP 429 和 500+ 最多短退避重试一次；其他 HTTP 状态和所有输出/Evidence 失败不得重试。
- 提供使用当前 Router `/models` 与脱敏固定输入的兼容性验证记录，模型选择仍由 `LLM_MODEL` 配置驱动。
- 保持 Queue Message、分析窗口、GraphQL/企业微信超时、Statistics、Evidence 严格校验和规则降级语义不变。

## 非目标

- 不在代码中硬编码或自动切换模型，不执行生产模型探测、部署或真实企业微信发送。
- 不修改 Cloudflare 查询、Queue 重试、通知重试、分析窗口或任何 Cloudflare 线上资源。
- 不放宽 Zod/Evidence 校验，不发送未经校验的 LLM 原文，不新增存储、幂等或新的 SDK。

## 影响范围

- `src/clients/llm.ts`：响应契约、错误分类、安全诊断和一次内部临时重试。
- `src/config/env.ts`、`src/config/dependencies.ts`、`wrangler.jsonc`：新增有界业务配置并注入 Client。
- `README.md`、`docs/deployment-verification.md`、`docs/release-checklist.md`：记录配置、验证和回滚边界。
- LLM、配置、AI Analyzer、失败矩阵和日志脱敏测试；新增模型验证的脱敏脚本/记录仅用于人工比较，不改变运行时契约。

## 风险与兼容性

- 一次内部重试会增加最坏延迟，因此使用短退避并计入同一个 LLM 调用预算；耗尽后仍返回最终 LLM 失败并走规则降级，不重查 GraphQL、不重算 Statistics、不重放 Queue、不重复通知。
- Provider 可能返回缺失或非整数 token usage，诊断字段采用可选安全数值，不因诊断缺失改变业务结果。
- Provider 对 `finish_reason`、`refusal` 或 `/models` 的支持可能不一致；兼容性验证只推荐同时满足结构化 JSON Schema、`strict=true`、稳定校验和低于当前基线延迟的模型，最终仍由配置决定。

## 验收标准

- 所有指定 LLM 输出、HTTP 和配置边界测试通过；Schema 错误日志只含字段路径，不含字段值或完整原文。
- `llmMaxOutputTokens` 默认 2048，512/8192 通过，越界和非整数拒绝；请求体使用配置值。
- 429/503 最多两次 HTTP 调用，400/401 一次调用；输出失败一次调用。
- LLM 最终失败仍发送规则降级通知，GraphQL 和企业微信调用各只发生一次。
- 严格 OpenSpec、工作流、类型、Lint、测试和 GitNexus 检查均通过。
