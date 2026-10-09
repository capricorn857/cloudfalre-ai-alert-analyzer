# Cloudflare AI Alert Analyzer

## 项目简介

Cloudflare AI Alert Analyzer 是面向运维与安全工程师的 Cloudflare Workers WAF 告警分析系统。它接收 Cloudflare WAF 告警，在固定时间窗口内完成一次只读快照分析，先排除明确的 block 事件，再将待关注事件的确定性规则分析与可选 AI 分析结果发送到企业微信；符合条件的过滤后观察零结果正常静默。

系统不修改 WAF、Zone 或其他 Cloudflare 配置，也不持续追踪后续事件。本文仅说明操作流程，不授权创建远端资源、写入 Secret 或部署生产环境。

## 处理流程

```text
Cloudflare Security Events 通知
  -> POST /api/v1/alerts/cloudflare
  -> Schema 校验、固定分析窗口、延迟写入 Queue
  -> cloudflare-ai-alert-analyzer Queue
  -> GraphQL 原始总量/Action分布与过滤后总量/Top Host发现
  -> 范围一致性检查：观察零静默，无法判断则基础降级通知
  -> 同一固定窗口内按 Host 过滤采集、独立统计与规则
  -> 一次多 Host AI 分析或按 Host 规则降级
  -> 单条企业微信通知（2000 UTF-8 字节以内）
```

## 运行边界

- Worker 和 GraphQL 查询均为只读，不会自动执行 WAF 配置变更。
- 每条有效告警只执行一次固定窗口快照；技术重试复用首次确定的窗口，不重新计算或扩大窗口。
- Queue 使用至少一次投递语义，极端情况下可能产生重复通知；通过通知中的 `incident_id` 和 `correlation_id` 人工识别。
- LLM 失败会产生确定性规则降级通知，不会因此丢弃告警或重放整条消息。
- MVP Webhook 没有入站鉴权。若 Cloudflare Notifications 需要调用该端点，不得以 Cloudflare Access 保护该路由；生产使用前应明确接受公网入口风险并配置流量观测。

## 已拦截事件静默

固定策略 `exclude-exact-block-v1` 仅排除原始 Action 严格等于 `block` 的事件，不区分自定义/托管规则或查询IP名单。过滤发生在Top Host选择之前，Host统计、样本、Findings、AI Evidence及通知共用待关注范围；非block不证明攻击成功或已到达源站。

发现阶段在同一固定窗口查询原始总量、未过滤Action分布（最多20组）、过滤后总量及Top Host。只有分布未截断、类别无重复且完整计数一致，才继续分析或静默。block计数直接取完整分布中的block组，不用两个独立采样总量相减。

- 原始总量为正、待关注聚合为零、直接block计数与原始总量一致且过滤Top Host为空：跳过LLM和企微，记录 `alert_suppressed` / `no_attention_events_observed` 并ack。
- 原始窗口有效零：发送数据不足基础通知；查询失败、关键数据缺失、Action分布截断/冲突：发送受控降级通知。
- null、字段缺失或空Action不视为block；原始分布有正计数不可判定类别时，无法可靠保留过滤范围，基础降级且不调用AI。已可靠返回的Host未知动作保留为unknown并标注，非空未来Action及大小写/空白变体不冒充block。

这是Adaptive聚合的“未观察到”策略，已明确接受采样漏掉稀少非block事件的风险，不宣称所有底层请求都已拦截。日志保留策略、窗口、关联ID、估计计数和采样限定；静默日志失败不主动重放，也不记录企微发送成功。

不新增策略vars或Queue字段。新旧合法v1消息均使用本策略及原固定窗口；整包回滚会恢复旧版本block提醒，可能跨版本重复通知，不回补已静默历史事件。

## 前置条件

使用条件之外，AI 当前采用以下结构化证据边界：

- 对外 Catalog v2 按 Zone/Host 标识归属，每 Host 最多64项/10 KiB，整体最多328项/56 KiB；AI v3 返回带 `host_id` 的受控结论与逐条引用。程序取值并模板渲染，跨 Host 引用、旧 v2 响应和自由文本均拒绝。
- 引用须满足角色、必要证据、阈值及样本口径。风险是规则关注等级，CRITICAL 暂无支持规则；攻击类型仅允许符合条件的疑似 Bot，其他情况使用 Unknown。置信度为受限模型自评，不是攻击概率；不能从独立 Top IP/Path 推断联合关系。
- 诊断使用 `llm_output_schema_invalid`、`ai_reference_invalid`、`ai_reference_type_mismatch`、`ai_claim_unsupported`、`ai_data_insufficient`、`ai_catalog_invalid`，配合受控 `validation_reason`、`validation_paths` 和计数。目录错误属于本地 `analysis_failed`；不记录实体、引用 ID、Prompt 或模型原文。
- 单 Host 输出失败只降级该 Host，根结构无效则全部 AI 降级，不额外查询、重算统计或重放 Queue。已有真实 Provider 记录属于旧 v2，不能证明 v3 兼容性；本次未调用真实模型或企微，详见[实测记录](docs/llm-model-compatibility.md)。

开发与运行所需条件：

- Node.js `>=22.0.0` 与 npm。
- 具备配置 Cloudflare Workers、Queues、Workers Builds 与 Variables and Secrets 的权限。
- 准备最小权限的只读 Cloudflare GraphQL Analytics Token、LLM 中转服务和企业微信机器人。
- 本地测试和验证仅使用虚构或脱敏数据，不使用生产企业微信机器人。

## Cloudflare 资源

在部署前由授权人员准备以下单套资源：

| 资源 | 名称或用途 | 说明 |
| --- | --- | --- |
| Worker | `cloudflare-ai-alert-analyzer` | Module Worker，同时作为 Webhook producer 和 Queue consumer。 |
| Queue | `cloudflare-ai-alert-analyzer` | 消费者 `max_batch_size = 1`，用于延迟投递和有限重试。 |
| Queue binding | `ALERT_QUEUE` | Queue binding，不是 Text 变量。 |
| Workers Builds | GitHub 仓库构建与部署 | 使用 Build Configuration 中选定的 Build Token。 |

## 本地验证

从仓库根目录安装依赖并执行质量门禁：

```bash
npm ci
npm run types
npm run typecheck
npm run lint
npm test
```

本地开发可运行 `npm run dev`。开发环境变量使用被 Git 忽略的 `.dev.vars`，只填入本地、虚构或脱敏值；不要把 Secret 写入 Git、文档、夹具或日志。

独立 LLM 实测运行 `npm run test:llm:live`，读取本地 `.env` 的三个 LLM 字段，用虚构数据发起 3 次真实模型调用（可能计费），不查询 Cloudflare、不发送企微。默认 `npm test` 不执行该实测；接口配置、结果与限制见[模型兼容性验证记录](docs/llm-model-compatibility.md)。

## Workers Builds

在 Cloudflare Dashboard 的 Workers Builds 为本仓库配置以下项目：

| 设置 | 值 |
| --- | --- |
| Worker name | `cloudflare-ai-alert-analyzer` |
| Production branch | `master`，或仓库选定的生产分支 |
| Root directory | `/` |
| Build command | `npm run types && npm run typecheck && npm run lint` |
| Deploy command | `npm run deploy` |

本项目不需要任何 Workers Builds environment variables。Build Token 与运行时 `CLOUDFLARE_API_TOKEN` 是两套独立凭证：Build Token 只在 Build Configuration 中用于部署认证，运行时 Token 只用于 Worker 的只读 GraphQL Analytics 查询。不要将 `CLOUDFLARE_API_TOKEN` 配置为构建变量，否则可能干扰 Wrangler 的部署认证。

如 Build Token 被删除或轮换，必须在 Build Configuration 中替换。初始 `seed_repo` 构建无法重试；向生产分支创建新的提交会触发正常构建。若 GitHub 部署仓库未包含 `test/`，请在本地执行 `npm test`。

## 运行时配置

运行时凭证应仅配置在 Cloudflare Dashboard：`Workers & Pages > cloudflare-ai-alert-analyzer > Settings > Variables and Secrets`。不要将它们作为 Workers Builds variables 配置。

| 配置项 | 类型与归属 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret，Dashboard 运行时配置 | 最小权限、只读的 GraphQL Analytics 查询凭证。 |
| `LLM_API_KEY` | Secret，Dashboard 运行时配置 | LLM 中转服务凭证。 |
| `WECOM_WEBHOOK_URL` | Secret，Dashboard 运行时配置 | 企业微信机器人完整 Webhook 地址。 |
| `LLM_BASE_URL` | Text，Dashboard 运行时配置 | OpenAI 兼容中转服务的 `/v1` 基础地址。 |
| `LLM_MODEL` | Text，Dashboard 运行时配置 | 中转服务支持的模型标识。 |
| `BUSINESS_CONFIG` | Wrangler 管理 | `wrangler.jsonc` 中的业务窗口、采样、超时、重试、显示时区和规则阈值。 |
| `ALERT_QUEUE` | Queue binding | 连接 producer 与 consumer 的 Queue binding，不填为文本配置。 |

`BUSINESS_CONFIG.llmTimeoutMs` 只控制 LLM 单次调用超时，未配置时默认为 `30000` 毫秒；可显式配置 `1000` 至 `120000` 范围内的整数覆盖默认值。`BUSINESS_CONFIG.llmMaxOutputTokens` 控制 `max_completion_tokens`，默认 `2048`，可显式配置 `512` 至 `8192` 的整数。Cloudflare GraphQL 和企业微信继续使用 `requestTimeoutMs`，不会随 LLM 超时或输出预算一起扩大。LLM 仅对 HTTP `429`/`5xx` 最多内部重试一次；输出校验失败直接进入规则降级。

`BUSINESS_CONFIG.hostLimit` 默认3，整数范围1..5，写入 Queue 的 `configSnapshot`；旧 v1 消息缺此字段时固定使用3，不受消费时配置变化影响。`sampleLimit` 默认50、最多100，现为每 Host 的样本上限。发现最多10个候选，不分页补采；空 Host 不查询、不用 Zone 名补齐。

正常 GraphQL 请求数为 `1+2H`，默认7次，最多两路HTTP并发；采集总截止90秒含响应体和退避，每个操作至多2次技术重试。发现阶段4个alias、每Host7个聚合alias和1个样本node，正常node selections为4+8H（最大44，含技术重试最大132）。Host比例以过滤后Host总量为分母，UA以该Host非空UA样本数为分母；Zone覆盖只计入完整一致的Host聚合，失败不记零，发现计数不一致时覆盖显示未知。相同Host的独立ASN/IP/Path排名也不构成联合归因。

通知按Zone、Host关注与防护、集中建议、时间覆盖追踪排列。IP/Path默认Top3、Country/ASN默认Top1，预算不足整项省略。新Webhook的关联ID最多128 UTF-8字节；旧Queue仍可读，若完整历史ID导致最小消息不可表示，则记录 `notification_content_unrepresentable` 并ack，不发送丢失追踪信息的替代消息。

普通追踪ID保持原样；控制字符密集的ID若转义后过长，会完整显示为带标签的 `[utf8-base64:...]`（孤立UTF-16代理项使用 `[utf16le-base64:...]`），可无损还原，不截断ID。每个被压缩的Host单独标记“明细已省略”；失败Host的发现阶段计数明确标为未完成分析，不能作为该Host统计分母。

模型切换仍只通过 `LLM_MODEL` 完成。候选模型必须先按[模型兼容性验证记录](docs/llm-model-compatibility.md)使用 Router `/models` 和脱敏固定输入比较，不在 Worker 中自动探测或硬编码模型。

`npm run deploy` 使用 `--keep-vars`，以保留 Dashboard 管理的 `LLM_BASE_URL` 和 `LLM_MODEL`。所有凭证均不得进入 `wrangler.jsonc`、Git、日志、测试夹具或本文档。

## 首次部署

以下顺序用于授权后的首次部署；执行远端操作前应完成发布审批。

1. 创建单一 Worker 和同名 Queue，并确认 `ALERT_QUEUE` producer/consumer binding 与 `max_batch_size = 1`。
2. 在 Workers Builds 连接仓库，设置生产分支、构建命令和部署命令，并确认 Build Token 有效。
3. 在 Worker Settings 的 Variables and Secrets 填入三个 Secret 和两个 Text 变量；`BUSINESS_CONFIG` 保持由 `wrangler.jsonc` 管理。
4. 本地运行质量门禁，并执行 `npx wrangler deploy --dry-run --keep-vars` 校验部署配置。
5. 经明确授权后，使用 `npm run deploy` 部署。
6. 按下文完成 Webhook 接入和部署后验证。

## Webhook 接入

将 Cloudflare Security Events 通知目标配置为：

```text
POST /api/v1/alerts/cloudflare
```

Webhook 仅在受支持、通过校验的 Payload 成功写入 Queue 后返回 `202 Accepted`。它不直接调用 GraphQL、LLM 或企业微信。MVP 没有入站鉴权；请结合上游通知来源和平台侧流量观测控制风险，且不要对该路由启用会阻断 Cloudflare Notifications 的 Cloudflare Access。

## 部署后验证

使用脱敏的有效 WAF Payload 完成一次端到端检查：

1. 确认 Webhook 返回 `202 Accepted`，且 Queue 成功入队后才返回成功。
2. 确认 Queue 延迟投递，consumer 使用固定窗口且重试不移动 `query_started_at` 或 `analysis_window`。
3. 确认 GraphQL 使用同一分析窗口；在 Dashboard 用相同窗口核验聚合统计并记录可解释的采样差异。
4. 模拟 LLM 不可用，确认仍发送确定性规则降级通知。
5. 检查 Workers Logs 可用 `incident_id`、`correlation_id` 关联，并且没有 Token、API Key、Authorization 或企业微信 Webhook URL。

完整步骤见[部署验证手册](docs/deployment-verification.md)。

## 常用命令

```bash
npm run dev
npm run types
npm run typecheck
npm run lint
npm test
npm run deploy
```

部署前推荐依次执行 `npm run types`、`npm run typecheck`、`npm run lint` 和 `npm test`；远端部署、Secret 写入和资源创建仍需单独授权。

## 故障排查

| 现象 | 检查与处理 |
| --- | --- |
| Workers Builds 认证失败 | 确认 Build Token 未删除或轮换；如已失效，在 Build Configuration 替换，而不是修改运行时 `CLOUDFLARE_API_TOKEN`。 |
| 初始构建不能重试 | `seed_repo` 初始构建不能重试；创建新的生产分支提交以触发正常构建。 |
| Wrangler 部署认证异常 | 确认没有将运行时 `CLOUDFLARE_API_TOKEN` 设置为 Builds variable。 |
| 配置校验失败 | 在 Worker Settings > Variables and Secrets 核对三个 Secret、两个 Text 变量和 `ALERT_QUEUE` binding；确认 `BUSINESS_CONFIG` 符合 `wrangler.jsonc`。 |
| 未收到 AI 结论 | 查看脱敏日志的 `error_code` 和 `duration_ms`；`llm_timeout` 可在 `BUSINESS_CONFIG.llmTimeoutMs` 的 `1000` 至 `120000` 范围内调整，其他 LLM 失败仍按确定性规则降级。 |
| 收到重复通知 | Queue 是至少一次投递；使用通知中的 `incident_id` 和 `correlation_id` 比对重复消息。 |
| Cloudflare Notifications 无法访问 Webhook | 核对路径、方法与上游通知配置；不要以 Cloudflare Access 阻断无入站鉴权的 MVP Webhook。 |

## 回滚

Host版本须整包切换采集、Catalog v2、AI v3、Prompt、支持校验、Formatter和诊断。Queue仍为v1，旧Consumer会忽略hostLimit并恢复Zone级分析；回滚到前一结构化证据版本将失去Host分组并恢复旧通知缺陷。不要回滚到自然语言实体扫描版本。无需清空Queue或迁移Secret；至少一次投递下仍可能跨版本重复通知。当前变更不授权发布、Secret写入或云资源操作。

验证失败时部署上一已验证的 Worker 版本。不要清空 Queue、删除远端资源、扩大在途消息的固定窗口或移动重试窗口；保留脱敏日志和事件身份标识以支持排查。必要时先暂停 Queue consumer，并按[部署验证手册](docs/deployment-verification.md)重新执行端到端核验。
