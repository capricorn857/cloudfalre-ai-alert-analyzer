---
status: implemented
---

# 变更提案：结构化证据引用

## 背景

当前 `src/analysis/evidence.ts` 从 LLM 的 summary、evidence、recommendations 扫描 IP、路径、ASN 并与输入字符串比较。已确认误报可复现：`/index.php` 被截成 `/index`，`WAF/API`、`ExampleClient/1.0` 的片段被当作路径。尚未确认这是最近一次线上失败的直接原因，本 Change 不作线上根因结论。

## Why

实体字符串存在不等于分析结论成立。以有界目录、逐条引用、受控结论及确定性支持条件替代自然语言实体扫描，才能同时消除这类误报并约束无关引用。

## 目标

- 从已校验 Incident、Statistics、Findings 派生 Evidence Catalog，保留原义、来源和聚合/样本口径，稳定生成局部 ID。
- 每条风险、攻击假设、观察和建议绑定引用；程序验证类型、完整性、数据充分性和支持条件。
- Formatter 仅从已验证目录与受控模板取值，不开放模型自由文本展示通道。
- 失败仍发送规则降级通知；安全诊断可区分结构、引用、类型、支持和数据不足错误。

## What Changes

- **BREAKING**：替换内部 AIAnalysis 与 Provider JSON 输出契约，删除 summary/evidence/recommendations 自由文本及其正则扫描。
- 新增结构化目录、输出 Schema、支持策略和模板；Provider Schema 从同一 Zod 结构契约生成。
- **BREAKING**：风险允许 Unknown，CRITICAL 暂无可支持规则；攻击类型仅开放受限 Bot 假设，其余具体类型在当前证据能力下要求 Unknown。保留攻击类型枚举用于明确拒绝无支持输出，而非允许模型任意选择。
- 保留 GraphQL、统计、规则、Queue 固定窗口和外部调用重试边界；调整 AI Analyzer 为统一语义校验入口。

## 非目标

不新增查询、统计模型、存储、基础设施、LLM SDK、自由文本语义审查模型或自动处置；不证明攻击意图、业务损失或模型所有语义判断正确。不执行生产部署、Secret 写入、Cloudflare 资源变更、真实机器人通知或模型探测。

## Capabilities

### New Capabilities

- `structured-evidence-references`：定义目录、受控输出、支持规则、安全诊断与通知的完整替代契约。

### Modified Capabilities

无已同步的主 Spec 可直接 MODIFIED（`openspec list --specs` 返回空）。本能力不是平行 AI 系统；其需求明确替代未归档 MVP 的 Structured AI output / Evidence traceability / Advisory-only recommendations，以及 optimize-llm-analysis 的 invalid evidence 诊断子场景，并细化 Formatter-owned message。以后同步须先处理前序 Change，再将冲突旧条款替换为本能力的引用，不能让两套输出契约同时有效。未经用户指示不修改前序 Change 或主 Specs。

## 影响范围

`src/domain/ai-analysis.ts` 及新增目录契约；`src/analysis/evidence.ts`、`ai-analyzer.ts` 及新增目录生成模块；`src/clients/llm.ts`、`contracts.ts`；`src/notification/formatter.ts`；`src/observability/errors.ts`、`logger.ts`；`src/pipeline/process-alert.ts` 的诊断映射；对应单元、Workers 集成测试和虚构夹具；README、模型兼容性及发布文档。

Webhook 和 Queue Message 不迁移，Statistics/Finding/Incident 保持原模型，Catalog 为短生命周期派生视图。无 bindings、Secret、权限或部署配置变更。

## 风险与兼容性

- 这是有意收紧表达能力的契约升级，旧响应不做宽松转换；旧模型输出将降级。攻击类型更常为 Unknown，风险为规则关注等级而非已证实危害。
- 仅验证声明满足规定的支持策略；样本偏差、上游数据真实性、攻击意图和启发式误判仍无法由引用校验证明。
- 目录裁剪不能改写实体；被遗漏证据不可引用，支持材料不完整时 Unknown 或规则降级。
- AGENTS.md 的“无源码”和“无 package.json”已过时；实际源码及 npm 工具存在。AGENTS.md 的双环境要求与已确认 MVP/技术栈的单环境约定存在差异，本任务不创建环境；发布前必须单独确认实际隔离与授权条件。
- 以整包代码版本回滚 Prompt、Schema、校验和模板，不能仅回滚一个字段或启用新旧校验双跑。

## 验收标准

目录、模型输出及可展示结果经 Zod 和支持规则校验；真实但无关、缺少必要证据、样本冒充总体、数据不足却确定判断均拒绝。点号路径、URL、User-Agent、中文及查询参数原义展示，额外自由文本严格拒绝。诊断只含受控路径/枚举/计数，不含模型字符串或实体。所有 AI 失败不新增采集、不移动窗口、不重算统计、不重放 Queue。Workers 测试、typecheck、lint、OpenSpec 和适用 GitNexus 检查通过后才可宣称实施完成。
