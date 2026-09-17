# 实施任务：Cloudflare WAF 告警分析 MVP

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单个 Cloudflare Worker 中实现 WAF Webhook -> 固定窗口 Queue -> GraphQL 快照 -> 确定性分析 -> 受 Evidence 约束的 AI/降级 -> 企业微信通知的完整 MVP。

**Architecture:** `src/index.ts` 只组合依赖和导出 Module Worker Handlers；HTTP 与 Queue 边界通过 Zod 收敛为领域契约；Pipeline 依赖窄 Client 接口，按固定窗口执行一次快照并隔离各阶段重试。Statistics、Rules、Evidence 校验和 Formatter 使用纯函数，所有外部 HTTP 行为通过 Workers Fetch API 实现并在 Workers Runtime 中测试。

**Tech Stack:** TypeScript strict mode、Cloudflare Workers、Cloudflare Queues、Fetch API、Zod 4.x（最低 4.5.0）、Wrangler、Vitest 4.1+、`@cloudflare/vitest-plugin`、ESLint、npm。

## Global Constraints

- 只读：不得调用 Cloudflare 配置写 API，不得自动执行 AI 建议。
- 固定窗口：`query_started_at = webhook_received_at + settle_seconds`，`start = alert_time - before_minutes`，`end = query_started_at`；默认分别为 60 秒和 30 分钟。
- Queue：`max_batch_size = 1`，至少一次投递，技术重试复用原消息、身份标识和窗口，不承诺 exactly-once。
- 边界：Webhook、Queue Message、vars、外部 API 响应和 LLM 输出均须经过 Zod；外部输入类型为 `unknown`。
- 统计：比例只使用 GraphQL `total_events`；Payload `events_count` 仅作参考；零分母必须显式表示数据不足。
- AI：只接收 Incident、Statistics、Findings；失败降级且不得触发整条消息重放；Formatter 不接触未校验原文。
- 安全：Secret 仅通过 Workers Secrets；日志、代码、文档和夹具不得含真实 Credential。
- 环境：只使用一套 `cloudflare-ai-alert-analyzer` Worker、Queue 和运行时配置；未经明确授权不得部署或写入任何真实 Secret。
- 工程：ES Modules、Module Worker、固定 `compatibility_date`，不依赖未经启用和测试的 Node.js 专属 API。

## 文件与接口约定

- `src/domain/alert.ts` 导出 `CloudflareAlertPayloadSchema`、`AlertSchema`、`CloudflareAlertPayload`、`Alert`。
- `src/domain/queue-message.ts` 导出 `AnalysisWindowSchema`、`QueueMessageSchema`、`AnalysisWindow`、`QueueMessage`，消息版本固定为 `schemaVersion: 1`。
- `src/domain/incident.ts`、`statistics.ts`、`finding.ts`、`ai-analysis.ts` 分别导出同名 Schema 与推导类型。
- `src/pipeline/window.ts` 导出 `buildQueueMessage(payload, config, now): QueueMessage` 与 `validateFixedWindow(message): void`。
- `src/clients/contracts.ts` 导出 `CloudflareAnalyticsClient`、`AIAnalysisClient`、`NotificationClient`、`Clock` 窄接口。
- `src/analyzers/waf-analyzer.ts` 导出 `analyzeWafAlert(message, dependencies): Promise<AnalysisResult>`。
- `src/pipeline/process-alert.ts` 导出 `processAlert(message, dependencies): Promise<ProcessResult>`，只编排，不实现统计或格式化。
- `src/api/cloudflare-alert.ts` 导出 `handleCloudflareAlert(request, env, dependencies): Promise<Response>`。
- `src/notification/formatter.ts` 导出 `formatWeComMessage(result, options): string`，输入只能是已校验的判别联合。

## 任务

以下任务按依赖顺序实施。每个子任务完成其测试和命令验证后立即勾选，父任务仅在全部子任务通过后勾选。

## 1. 工程基线与 Workers 测试环境

- [x] 1. 建立可运行、可生成 bindings 类型并能在 Workers Runtime 测试的工程基线；完成条件为 1.1 至 1.3 全部通过
- [x] 1.1 创建 `package.json`、`package-lock.json`、`tsconfig.json`、`eslint.config.js`、`vitest.config.ts` 和 `.gitignore`，配置 `dev`、`types`、`typecheck`、`lint`、`test`、`deploy` scripts 及锁定版本范围；运行 `npm install` 后验证 lockfile 可重复生成、`npm run typecheck` 与 `npm run lint` 在空实现基线通过。
- [x] 1.2 创建 `wrangler.jsonc`，固定 `compatibility_date`，在顶层声明单一 Worker 的 Queue producer/consumer、`max_batch_size = 1`、有限重试和三个必需 Secret 名称，不写入 Secret 值；运行 `npm run types` 并验证生成的 `worker-configuration.d.ts` 包含 Queue、vars 与 Secret bindings。
- [x] 1.3 创建 `test/tsconfig.json`、`test/fixtures/` 和 Workers Vitest 基础配置，加入一个最小 Runtime smoke test；先验证测试因缺少 Worker export 失败，再添加只含 Handler 壳的 `src/index.ts` 使 `npm test -- test/integration/worker-smoke.test.ts` 通过，且 `index.ts` 不包含业务逻辑。

## 2. 领域 Schema 与配置契约

- [x] 2. 建立全部运行时边界与内部领域契约；完成条件为 2.1 至 2.4 全部通过且 Schema 推导类型无 `any`
- [x] 2.1 在 `test/unit/domain/alert.test.ts` 先覆盖合法 Payload、缺字段、非法带时区时间和不受支持字段处理，再实现 `src/domain/alert.ts` 的 `CloudflareAlertPayloadSchema`/`AlertSchema`；验证 `npm test -- test/unit/domain/alert.test.ts` 从预期失败变为通过。
- [x] 2.2 在 `test/unit/domain/queue-message.test.ts` 先覆盖 `schemaVersion: 1`、UTC 时间、窗口有序、必需身份字段和未知版本拒绝，再实现 `src/domain/queue-message.ts`；验证单文件测试通过且推导类型不使用 `any`。
- [x] 2.3 在 `test/unit/domain/analysis-models.test.ts` 先定义 Incident、Statistics、Finding、AIAnalysis 的合法与非法样例，再实现 `src/domain/incident.ts`、`src/domain/statistics.ts`、`src/domain/finding.ts`、`src/domain/ai-analysis.ts`；验证风险枚举、置信度范围、最多 3 条建议和零数据状态均由 Schema 强制。
- [x] 2.4 在 `test/unit/config/env.test.ts` 先覆盖完整配置、缺 Secret、非法 URL、越界窗口/样本/重试/超时和不递增阈值，再实现 `src/config/env.ts` 与 `src/config/rules.ts` 的配置解析；验证错误只暴露配置键名而不包含输入 Secret 值。

## 3. 固定窗口与 Webhook 接入

- [x] 3. 完成只负责校验、映射、固定窗口和可靠入队的 HTTP 接入；完成条件为 3.1 至 3.4 全部通过
- [x] 3.1 在 `test/unit/pipeline/window.test.ts` 使用注入时钟先覆盖默认值、自定义值、时区归一、稳定 `incidentId`/`correlationId` 和 Consumer 一致性校验，再实现 `src/pipeline/window.ts`；验证重试时间晚于窗口结束时 `validateFixedWindow` 不修改任何消息字段。
- [x] 3.2 在 `test/unit/pipeline/dispatcher.test.ts` 先覆盖 `clickhouse_alert_fw_anomaly -> waf_attack` 和不支持类型，再实现 `src/pipeline/dispatcher.ts` 的显式映射；验证新增 Analyzer 的分发契约不依赖 AI 或通知模块。
- [x] 3.3 在 `test/integration/cloudflare-alert-route.test.ts` 先覆盖 `404`、`405`、非法 JSON、缺字段、非法时间、请求体超限、不支持类型、Queue 失败和成功 `202`，再实现 `src/api/cloudflare-alert.ts`；验证只有 Queue `send` 成功后返回 `202`，且成功调用包含与 `settleSeconds` 相同的 `delaySeconds`。
- [x] 3.4 在同一集成测试中注入 GraphQL、LLM 和 WeCom 哨兵 Fetch，证明 Webhook 请求不会访问这些端点；接入 `src/index.ts` 的 `fetch` Handler 并验证路由测试在 Workers Runtime 中通过。

## 4. 错误分类、重试与脱敏日志

- [x] 4. 建立统一且可测试的错误、有限重试与日志安全基础；完成条件为 4.1 至 4.3 全部通过
- [x] 4.1 在 `test/unit/observability/errors.test.ts` 先覆盖 timeout、429、5xx、401、输入错误、Schema 错误、AI 降级、通知失败和 post-send 错误分类，再实现 `src/observability/errors.ts` 的稳定 `errorCode` 与 `retryable` 判定；验证每类错误映射唯一且非临时错误不重试。
- [x] 4.2 在 `test/unit/clients/retry.test.ts` 使用 fake timers 先覆盖首调成功、临时错误后成功、次数耗尽和永久错误，再实现 `src/clients/retry.ts` 的有限短退避；验证总尝试次数等于首次调用加配置的 1 至 2 次重试，且 Abort/退避均受 Worker 执行预算限制。
- [x] 4.3 在 `test/unit/observability/logger.test.ts` 用哨兵 Token、API Key、Authorization、Webhook URL 和超长响应先写失败断言，再实现 `src/observability/logger.ts` 的单行 JSON、截断和递归脱敏；验证日志保留 `incident_id`、`correlation_id`、窗口、阶段、耗时和 `error_code`，但 `rg`/断言均找不到哨兵 Secret。

## 5. Cloudflare GraphQL 快照客户端

- [x] 5. 完成固定窗口、受限响应且正确区分临时/永久错误的 GraphQL 数据采集；完成条件为 5.1 至 5.3 全部通过
- [x] 5.1 在 `test/fixtures/graphql/` 添加虚构聚合、样本、空数据、GraphQL errors 和非法响应夹具，并在 `test/unit/clients/cloudflare-graphql-schema.test.ts` 先覆盖所有 Schema 分支，再实现 `src/clients/cloudflare-graphql-schema.ts`；验证 HTTP 200 下的 `errors` 不会被当作成功。
- [x] 5.2 在 `test/integration/cloudflare-graphql-client.test.ts` 使用 Workers Fetch Mock 先断言 Bearer 鉴权、GraphQL variables、相同固定窗口、`sampleLimit`、timeout 和响应校验，再实现 `src/clients/cloudflare-graphql.ts` 的 `CloudflareAnalyticsClient`；验证任何日志和错误都不含 Authorization 值或完整响应。
- [x] 5.3 在同一集成测试先覆盖 timeout/429/5xx 的有限重试以及 401/Schema 错误不重试，再接入 `src/clients/retry.ts`；验证每次重试使用完全相同的 `zoneTag`、`start` 和 `end`，且空数据不会发起第二轮业务查询。

## 6. 标准化、统计与规则分析

- [x] 6. 完成不依赖网络的确定性 WAF 分析链路；完成条件为 6.1 至 6.4 全部通过且每个结果可由输入复现
- [x] 6.1 在 `test/unit/analysis/normalizer.test.ts` 先覆盖完整数据、可选字段缺失、未知 Action/Source、UTC 时间和 Payload/GraphQL 事件数并存，再实现 `src/analysis/normalizer.ts`；验证输出符合 `IncidentSchema` 且不包含 GraphQL 原始响应。
- [x] 6.2 在 `test/unit/analysis/statistics.test.ts` 先覆盖 Top IP/Path/Country/ASN、allow/block/challenge 比例、聚合和不等于总量、舍入展示以及零分母，再实现 `src/analysis/statistics.ts`；验证所有比例只使用 GraphQL `totalEvents` 且零分母返回数据不足状态而非 `NaN`/无穷值。
- [x] 6.3 在 `test/unit/analysis/rules.test.ts` 先覆盖八类规则、medium/high 边界、阈值以下、样本不足和请求速率，再实现 `src/analysis/rules.ts`；验证每个 Finding 含稳定类型、等级、原始值、阈值和可引用 Evidence，且规则函数不直接读取 env。
- [x] 6.4 在 `test/unit/analyzers/waf-analyzer.test.ts` 先覆盖成功、空数据、GraphQL 最终失败和固定窗口透传，再实现 `src/analyzers/waf-analyzer.ts`；验证每次分析只调用一轮数据采集，并输出经过 Schema 校验的 `AnalysisResult` 判别联合。

## 7. LLM 结构化分析与降级

- [x] 7. 完成受 Evidence 限制且失败不阻断通知的 AI 分析；完成条件为 7.1 至 7.3 全部通过
- [x] 7.1 在 `test/fixtures/llm/` 添加虚构合法、非 JSON、缺字段、越界置信度、超量建议、编造实体和自动变更声明夹具，并在 `test/unit/analysis/evidence.test.ts` 先定义关键实体/数值映射规则，再实现 `src/analysis/evidence.ts`；验证不受输入 Evidence 支持的输出被拒绝，证据不足时只接受 `Unknown`。
- [x] 7.2 在 `test/integration/llm-client.test.ts` 使用 Fetch Mock 先覆盖 endpoint/model、超时、最大输出、仅允许结构化输入和 JSON Schema 校验，再实现 `src/clients/llm.ts`；验证请求不含原始 Payload、GraphQL 原始响应或 Credential，响应不直接泄露给 Formatter。
- [x] 7.3 在 `test/unit/analysis/ai-analyzer.test.ts` 先覆盖有效分析、网络失败、HTTP 错误、解析失败、Schema 失败、Evidence 失败和 Cloudflare 数据不可用，再实现 `src/analysis/ai-analyzer.ts`；验证所有 LLM 失败均返回显式 `AIUnavailable`/规则降级结果而非抛出 Queue 重试错误，Cloudflare 数据不可用时完全不调用 LLM。

## 8. 企业微信格式化与发送

- [x] 8. 完成固定格式、长度受控且重试不重复上游分析的企微通知；完成条件为 8.1 至 8.3 全部通过
- [x] 8.1 在 `test/unit/notification/formatter.test.ts` 先为成功 AI、AI 降级、空数据、Cloudflare 失败、事件数口径差异和配置时区编写快照断言，再实现 `src/notification/formatter.ts`；验证必含窗口/数据截至时间、`incident_id`、`correlation_id`、事实与推断分区，且不接受未校验 LLM 字符串作为输入。
- [x] 8.2 在 Formatter 测试中先覆盖超长 Top 列表、摘要、Evidence 和建议，再实现确定性的项目数、字段和总长度限制；验证截断后仍保留身份标识、窗口、失败/降级状态和最多 3 条建议，并符合企业微信消息长度约束。
- [x] 8.3 在 `test/integration/wecom-client.test.ts` 使用 Fetch Mock 先覆盖合法请求、timeout/429/5xx 重试、永久错误、重试耗尽和响应 Schema，再实现 `src/clients/wecom.ts`；验证所有重试发送完全相同的已格式化消息且不调用 GraphQL 或 LLM。

## 9. Queue Pipeline 与副作用边界

- [x] 9. 组合完整 Queue 消费链路并锁定 ack/retry 与不可逆通知副作用边界；完成条件为 9.1 至 9.4 全部通过
- [x] 9.1 在 `test/unit/pipeline/process-alert.test.ts` 通过窄接口 fake 先覆盖成功、AI 降级、空数据、Cloudflare 失败和 WeCom 失败，再实现 `src/clients/contracts.ts` 与 `src/pipeline/process-alert.ts`；验证调用顺序为校验 -> WAF 分析 -> AI/降级 -> 格式化 -> 通知，Pipeline 本身不重算统计或拼装外部请求，WeCom 最终失败返回 `notification_failed` 而不抛给 Queue。
- [x] 9.2 在 `test/integration/queue-handler.test.ts` 先覆盖无效消息确认丢弃、`processing_started_at` 仅用于日志、晚到/重试窗口不漂移、`queue_attempt` 和每批一条，再实现 `src/index.ts` 的 `queue` Handler；验证所有外部查询使用消息原窗口且毒消息不会无限重放。
- [x] 9.3 在 Queue 集成测试先模拟 WeCom 成功后的 Logger 异常和通知最终失败，再实现副作用保护；验证成功发送后的非关键错误和 `notification_failed` 均确认消息且不触发 Queue retry。
- [x] 9.4 在 `test/integration/full-pipeline.test.ts` 使用脱敏 Payload 与 Fetch Mock 完成 Webhook 入队、Queue 消费、GraphQL、LLM 和 WeCom 的全链路测试；验证固定窗口只生成一次、通知字段完整、每个阶段日志可通过相同身份标识关联，并验证通知最终失败不重复 GraphQL 或 AI。

## 10. 生产验收可观测性修复

- [x] 10. 按 Client、Pipeline、Logger 既有边界完成外部依赖失败观测修复；完成条件为 10.1 至 10.7 全部通过，且不改变固定窗口、重试、LLM 降级或 Queue ack 语义
- [x] 10.1 在 `test/unit/observability/errors.test.ts` 先增加失败测试，覆盖 timeout、Fetch `TypeError`、network、运行时可识别的 DNS/TLS/connection、unknown、HTTP 状态、`retryable` 和非负有限 `durationMs`，再最小修改 `src/observability/errors.ts` 建立结构化外部失败契约；验证稳定分类不依赖记录原始异常，单文件测试通过。
- [x] 10.2 在 `test/integration/wecom-client.test.ts` 先增加失败测试，覆盖安全的 Fetch `TypeError` 分类、timeout、HTTP `4xx`/`429`/`5xx`、非法 JSON/Schema、非零 `errcode` 和成功结果，再最小修改 `src/clients/wecom.ts`；验证结果使用规范化 `responseCategory`，HTTP 错误保留 `httpStatus`，且原始响应、`errmsg`、Webhook URL 和 key 不进入错误对象或日志。
- [x] 10.3 在 `test/integration/cloudflare-graphql-client.test.ts` 和 `test/integration/llm-client.test.ts` 先断言公共失败字段、HTTP 状态、GraphQL `errors` 的服务级分类和 LLM 降级所需上下文，再最小修改 `src/clients/cloudflare-graphql.ts`、`src/clients/llm.ts` 及公共 Client 辅助代码；验证三个外部服务使用同一稳定字段契约且保留既有限重试行为。
- [x] 10.4 在 `test/unit/analyzers/waf-analyzer.test.ts`、`test/unit/analysis/ai-analyzer.test.ts` 和相关领域测试中先断言 Cloudflare 具体 `errorCode`、结构化失败上下文及 LLM 降级上下文能够无损传播，再最小修改 `src/domain/analysis-result.ts`、AI 结果契约、`src/analyzers/waf-analyzer.ts` 和 `src/analysis/ai-analyzer.ts`；验证 GraphQL 失败不调用 LLM且不启动第二轮查询，LLM 失败仍返回降级结果。
- [x] 10.5 在 `test/unit/pipeline/process-alert.test.ts` 和 `test/integration/queue-handler.test.ts` 先增加失败测试，断言 `notification_failed` 包含 WeCom 公共失败字段及适用的 `snapshot_error_code`、被确认消费且 GraphQL/LLM 调用次数不增加，再最小修改 `src/pipeline/process-alert.ts` 和必要的窄接口；验证 Pipeline 不解析底层异常文本、不重算统计、不重新格式化或执行上游阶段。
- [x] 10.6 在 `test/unit/observability/logger.test.ts` 和 `test/integration/log-redaction.test.ts` 先注入含哨兵 Webhook URL、Token、API Key、Authorization 和 key 的异常名称、消息、cause 与 URL，再最小修改 `src/observability/logger.ts` 和安全诊断摘要逻辑；验证已知 Secret 替换、敏感 URL/query 清除、长度限制和递归脱敏全部生效，捕获日志不存在任何哨兵明文。
- [x] 10.7 扩充 `test/integration/failure-matrix.test.ts` 和必要的全链路测试，覆盖三类外部服务的 timeout、network、HTTP、非法响应与服务级错误组合；验证每个最终失败日志均含 `external_service`、`error_code`、`failure_kind`、`retryable`、`duration_ms` 和适用的专用字段，且 WeCom 最终失败仍 ack、不重跑 GraphQL 或 AI。

## 11. 安全、运行配置与回归验证

- [x] 11. 完成全量质量、安全、OpenSpec 和代码影响门禁；完成条件为 11.1 至 11.5 全部通过，无未解释的稳定字段缺失、敏感信息残留或 HIGH/CRITICAL 风险
- [x] 11.1 重新运行并核对 `test/integration/failure-matrix.test.ts`，覆盖 GraphQL、LLM、WeCom 在 timeout/network/HTTP/永久错误/非法响应下的组合边界；验证 GraphQL 失败不调用 LLM、LLM 失败仍通知、通知重试不重做分析，WeCom 最终失败被记录并确认，且所有客户端重试次数有限。
- [x] 11.2 重新运行 `test/integration/log-redaction.test.ts`，将唯一哨兵值注入全部 Secrets、Headers、URL、异常链和外部错误体并捕获日志；运行 `rg` Credential 泄漏扫描，验证源码、配置、文档新增内容、夹具和日志输出均不包含真实 Credential，日志输出不包含哨兵 Secret 明文。
- [x] 11.3 运行 `npm run types`、`npm run typecheck`、`npm run lint` 和 `npm test`，修复所有失败后再次完整运行；完成条件为四条命令退出码均为 0，且 bindings 生成文件与 `wrangler.jsonc` 一致。
- [x] 11.4 运行 `openspec validate implement-waf-alert-analyzer-mvp --strict` 和 OpenSpec 工作流校验脚本，核对实现覆盖五份 Specs 的每个 Scenario；完成条件为严格校验通过、无未解决占位符，且 `tasks.md` 仅按真实完成情况勾选。
- [x] 11.5 运行 `gitnexus status`，必要时运行 `gitnexus analyze`，最终执行 `gitnexus detect-changes --scope all`；若出现 HIGH/CRITICAL 风险，核对受影响调用方与测试后重新执行类型检查和完整测试。

## 12. 单环境验收与远端操作门禁

- [ ] 12. 完成单环境可操作验收证据和远端操作人工门禁；完成条件为 12.1 至 12.4 全部完成，其中任何外部授权未就绪时父任务保持未勾选
- [x] 12.1 编写 `docs/deployment-verification.md`，列明单一 Worker、Queue、Dashboard vars、Secrets、企微机器人、Cloudflare Token 的人工准备项和回滚步骤；验证文档不含真实 Credential，且不会执行未授权远端操作。
- [ ] 12.2 仅在用户另行明确提供远端操作授权且资源/配置就绪后，执行依赖安装、质量门禁、Wrangler 配置校验和部署；用脱敏告警验证 Route、Queue producer/consumer、固定窗口、外部 Fetch、企微消息和 Workers Logs。本次可观测性修复不得执行部署、Secret 写入、Cloudflare 资源变更或真实企业微信通知测试，未获授权时保持本任务未勾选。
- [ ] 12.3 仅在用户另行明确授权后，使用与通知完全相同的 `analysis_window` 对照 Cloudflare Dashboard，记录 Top IP、Path、Country、ASN、Action 和 `total_events` 的一致性或采样差异；验证 Payload `events_count` 仅作参考且不影响系统比例。
- [x] 12.4 编写 `docs/release-checklist.md`，包含单套资源、Dashboard vars、Secrets、回滚、监控、Credential 检查和人工批准项；验证清单明确远端部署与 Secret 写入必须另获用户授权，本 Change 实施过程中不执行这些操作。

## 验证命令

```bash
npm ci
npm run types
npm run typecheck
npm run lint
npm test
openspec validate implement-waf-alert-analyzer-mvp --strict
python .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/implement-waf-alert-analyzer-mvp
gitnexus detect-changes --scope all
```

`npm run deploy`、Wrangler Secret 写入和任何 Cloudflare 资源创建命令不属于默认验证命令；仅在对应环境获得用户明确授权后执行。
