---
status: implemented
---

# 变更提案：按 Host 独立分析与企微通知优化

## 批准记录

用户于2026-09-24明确回复“已审阅，可以执行”，授权在 `feat/host-scoped-alert-analysis` 实施本Change，包含128 UTF-8 bytes ID输入边界与已披露的GitNexus HIGH/CRITICAL影响。批准不豁免官方Schema/settings核验门禁，也不授权读取真实Secret、真实LLM/企微调用、云资源变更、提交、推送、部署、同步主Specs或归档。

后续用户单独授权了Cloudflare凭据的内存使用、目标Zone settings核验及互斥Host空结果探测，均已完成。2026-09-29完成本地实施和验收，证据见verification.md；其余远端操作权限未扩展。

## 背景

基线为当前 `master` 的 `ce86425`。实际已有 Worker、测试、Catalog v1 和 AI 输出 v2；AGENTS.md 中尚无源码、package.json 和索引的描述已过时。当前 `collectSnapshot` 发起 Zone 聚合与样本两个 HTTP 请求，独立 Top Host/Path/IP/ASN 等列表无法建立 Host 归属。Formatter 将 Zone 名称标为“域名”，首条建议在额外 Top 数据之前，摘要和 Evidence 重复，独立标题可能在预算裁剪后悬空。

## Why

运维需要分别看到根域与子域的来源、目标和防护结果，不能把不同 Host 的同名路径合并，也不能把独立排名误当联合归因。单条企微消息需在 2000 UTF-8 字节内优先展示可行动、可核验的事实。

## 目标

- 同一 Zone、同一固定窗口内，先发现 Top Host，再分别采集默认 3 个 Host（配置范围 1～5）。
- 每 Host 独立 Statistics、Findings、规则关注等级、采集状态及证据归属；展示实际已分析数及可信事件覆盖比例。
- 保持一个有界逻辑 LLM 请求，支持每 Host 验证与降级，保持受控结论及 Bot/Unknown 原门槛。
- 单条文本按 Zone 概览、Host 结果、集中建议、时间覆盖追踪排序，完整区块分配预算。

## What Changes

2026-09-29用户进一步指定通知排版：Host使用中文序号、标签独行及同类明细分组；隐藏规则关注和未知攻击类型文案，内部规则与排序保持不变。建议保留官方Dashboard链接，覆盖去掉重复限定语；失败/降级及必要判断限定语仍保留。本轮只改展示，不扩大真实发送或部署范围。

- **BREAKING**：内部 Incident/分析结果由 Zone 扁平证据迁移为 Zone 上下文与 Host 结果集合；GraphQL Client 增加发现及 Host 查询接口。
- **BREAKING**：Catalog 升级 v2、AI 输出升级 v3；引用携带 Host 归属及分母，结构正确但单 Host 语义失败只降级该 Host。
- Queue 保留 `schemaVersion=1`，在 `configSnapshot` 增加可选输入、解析后必有的 `hostLimit`；旧消息固定默认 3，producer 写入实际配置。窗口字段与等式不变。
- Formatter 改为中文区块、比例一位小数、默认 IP/Path Top 3、Country/ASN Top 1，优先保留防护结果、状态、窗口和完整追踪 ID。
- **BREAKING**：为保证追踪信息不被2000字节上限裁掉，新Webhook的incident_id/correlation_id各限128 UTF-8 bytes，超限400；旧Queue仍可读取，极端不可表示的历史消息受控记录通知失败并ack，不发送丢失ID的通知。

## 非目标

不实现 Host+ASN+Path 或 Host+IP+Path 交叉归因；不增加攻击判定类型，不开放模型自由文本事实；不持续查询、不补采、不分页穷举 Host；不新增多消息、详情服务、后台、数据库、KV、D1、Durable Objects、R2、Workflows、DLQ、SDK 或云资源。规划阶段仅创建artifacts；批准后允许按tasks实施生产代码与离线测试，不改旧 Changes、主 Specs，不归档、提交、推送、部署、读取真实 Secret 或调用真实 LLM/企微。

## Capabilities

### New Capabilities

- `host-scoped-alert-analysis`：Zone 发现、Host 独立采集/统计/证据、AI 验证、单条通知、兼容与运行约束。

### Modified Capabilities

无已同步主 Spec（`openspec list --specs` 返回空）。新增能力是现有链路的替代增量，不是并行分析系统。

## 影响范围

`clients/cloudflare-graphql*`、`clients/contracts.ts`、`domain/{alert,incident,statistics,finding,analysis-result,queue-message,evidence-catalog,ai-analysis}.ts`、新增Host领域Schema、`api/cloudflare-alert.ts`、`analyzers/waf-analyzer.ts`、`analysis/*`、`pipeline/{window,process-alert,queue-handler}.ts`、`config/{env,dependencies}.ts`、`clients/llm.ts`、`notification/formatter.ts`及区块预算纯函数、安全日志和对应测试、README/运行文档及非敏感业务配置。`index.ts` 保持组合入口；无需新增权限、bindings 或资源。

## 风险与兼容性

继承 MVP 的固定窗口、至少一次投递、通知阶段重试和 ack 语义；替代其 Zone 扁平采集与统一分母、旧通知布局。继承 optimize-llm-analysis 的超时、token 配置、安全诊断与仅 HTTP 429/5xx 一次重试。继承 structured-evidence-references 的受控语言、支持门槛及模板信任边界；替代其 Catalog v1、AI v2、全体降级与单 Zone 格式。设计包含逐条替代映射；本 Change 获批并实施后才成为这些条款的新契约，本轮不改前序 artifacts。

请求数、采样差异、有限目录及单消息预算会限制覆盖；失败不得记作零。公开官方文档不能证明目标 Zone 的完整字段和限额；无认证 introspection 返回 9106，必须在实施 GraphQL 查询前取得脱敏官方 Schema/settings 证据。Catalog、Prompt、Schema、支持验证、Formatter 必须整包升级/回滚。旧 Consumer 会忽略新增 Queue 字段并恢复 Zone 分析，回滚不保留 Host 功能。单环境现状与 AGENTS.md 双环境要求存在冲突，沿用前序已确认范围，本次不创建环境，任何实际发布另行确认。

## 验收标准

两个 Host 的相同 Path 计数不混合；Host 比例、Zone 覆盖及样本 UA 分母分别可核验；跨 Host 引用、错误分母及独立排名联合推断拒绝。部分 Host 失败不丢成功结果，单 Host AI 无效局部降级，整体结构无效全部 AI 降级；全部查询与重试的窗口完全一致。通知保留所有选中 Host 的结果或失败标记、必要限定语、完整时间/ID，无空标题或半条结论且不超过 2000 UTF-8 字节。四类虚构示例、TDD 任务及严格 OpenSpec/工作流校验齐备；用户已确认规划，仅实际验收通过的任务可勾选，全部实现与验证完成后才能标为implemented。
