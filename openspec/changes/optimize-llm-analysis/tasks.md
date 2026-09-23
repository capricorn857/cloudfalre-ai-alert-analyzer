# 实施任务：优化 LLM 分析链路

## 目标与全局约束

在 `feat/optimize-llm-analysis` 上以 TDD 实现已批准的 LLM 优化。不得修改 Queue Message、固定分析窗口、GraphQL/企业微信超时或线上资源；不得写 Secret、部署或发送真实企业微信通知。所有外部输入继续经过 Zod，日志不得保存原文、Prompt 或凭证。

## 任务

- [x] 1. 完成 LLM 响应阶段错误分类与安全诊断
  - [x] 1.1 在 `test/integration/llm-client.test.ts` 先覆盖 `finish_reason=length/stop`、refusal、非 JSON、Markdown JSON、Schema 缺字段/非法枚举/confidence 越界/recommendations 超限和 Evidence 不匹配，并断言预期错误码；先运行目标测试确认失败。
  - [x] 1.2 最小修改 `src/clients/llm.ts`、必要的 `src/observability/errors.ts` 和 `src/analysis/ai-analyzer.ts`，实现阶段优先级、`schema_issue_paths` 安全路径、usage/content length 诊断和无原文错误传播；运行目标测试确认通过。
  - [x] 1.3 在 `test/integration/log-redaction.test.ts` 增加 LLM 原文、Prompt、Token、Authorization、API Key、Webhook URL 哨兵，验证 Logger 和 AppError 均不泄露。

- [x] 2. 增加有界的 `llmMaxOutputTokens` 配置
  - [x] 2.1 在 `test/unit/config/env.test.ts`、`test/unit/config/dependencies.test.ts` 先覆盖默认 2048、显式覆盖、512/8192 边界、越界和非整数，并断言请求体值；确认实现前失败。
  - [x] 2.2 修改 `src/config/env.ts`、`src/config/dependencies.ts`、`wrangler.jsonc`，注入 512..8192 的配置并替换 800；保持其它 timeout 和 Queue 契约不变。
  - [x] 2.3 更新 `README.md`、`docs/deployment-verification.md`、`docs/release-checklist.md`，说明默认值、范围、覆盖和无线上操作边界。

- [x] 3. 实现一次 LLM 内部临时重试
  - [x] 3.1 在 `test/integration/llm-client.test.ts` 和 `test/integration/failure-matrix.test.ts` 先覆盖 429/503 一次重试、400/401 不重试、最终失败规则降级、GraphQL/企业微信调用不重复，并确认实现前失败。
  - [x] 3.2 在 `src/clients/llm.ts` 实现固定短退避、最多一次的 429/5xx 重试，记录总耗时和最终状态；禁止对输出失败、timeout 或永久错误重试。
  - [x] 3.3 在 `test/unit/analysis/ai-analyzer.test.ts` 验证所有 LLM 最终失败仍产生规则降级结果且 Evidence 规则未放宽。

- [x] 4. 建立模型兼容性验证记录
  - [x] 4.1 新增脱敏验证脚本或文档（不包含真实 URL、Token、模型响应原文），调用配置 Router 的 `/models` 和固定输入，采集 HTTP 状态、TTFB、总耗时、finish reason、JSON/Schema/Evidence 成功率。
  - [x] 4.2 明确推荐门槛和基线比较；不在代码中硬编码或自动切换模型，仅通过 `LLM_MODEL` 配置应用人工决定。

- [x] 5. 完成质量与安全门禁
  - [x] 5.1 运行 `npm run types`、`npm run typecheck`、`npm run lint`、`npm test`，修复失败并重新运行。
  - [x] 5.2 运行 `openspec validate optimize-llm-analysis --strict` 和 `python .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/optimize-llm-analysis`。
  - [x] 5.3 运行 `gitnexus status`、必要时 `gitnexus analyze` 和 `gitnexus detect-changes --scope all`；核对无 Credential 泄漏，明确未部署、未写 Secret、未改 Cloudflare 资源。

- [x] 6. 对齐 Provider JSON Schema 与本地 Zod Schema
  - [x] 6.1 在 `test/integration/llm-client.test.ts` 先断言 `response_format.json_schema` 包含 `confidence`、`summary`、`evidence` 和 `recommendations` 的完整边界，并覆盖超限输出仍被本地 Schema 拒绝；运行目标测试确认请求约束断言失败。
  - [x] 6.2 最小修改 `src/clients/llm.ts`，补齐 Provider Schema 的 `minimum`/`maximum`、`minLength`/`maxLength`、`maxItems`，并强化系统提示词；不得放宽 Zod、截断输出或对 Schema 失败重试。
  - [x] 6.3 运行目标测试及全量质量门禁，确认规则降级、Evidence 校验、Queue Message 和外部超时语义不变。

- [x] 7. 增加 Evidence 失败原因安全诊断
  - [x] 7.1 在 Evidence、AI Analyzer、LLM Client、失败矩阵和日志脱敏测试中先覆盖 `unsupported_entity`、`automatic_action_claim`、`insufficient_data`，确认失败原因字段当前缺失。
  - [x] 7.2 将现有 Evidence 规则结果分类为窄枚举，通过 `AppError`、`ExternalFailure` 和 Pipeline 安全日志传递；不记录实体值、原文、Prompt 或凭证，Evidence 失败保持不可重试。
  - [x] 7.3 强化系统提示词为安全分析约束，并运行全套类型、Lint、测试、OpenSpec 和 GitNexus 验证。

## 验证命令

```bash
npm run types
npm run typecheck
npm run lint
npm test
openspec validate optimize-llm-analysis --strict
python .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/optimize-llm-analysis
gitnexus status
gitnexus detect-changes --scope all
```
