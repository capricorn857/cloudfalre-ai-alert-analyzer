---
status: implemented
---

# 变更提案：聚合差异时保留 Host 分析

## 实施批准

2026-10-09 用户明确回复“已审核计划，可以实施”，批准本Change全部规划并授权按tasks连续实施与离线验证。此前规划阶段的“不写生产/测试代码”边界已由本次指令解除；提交、推送、合并、部署、资源修改、Specs同步和归档仍未授权。

## 背景

现有静默实现把“不能静默”与“不能分析”合并，普通独立聚合估计差异触发全局 suppression_ineligible，丢失仍可用的过滤后 Host 明细。本提案已获用户确认，实现及离线验证已完成，详见verification.md。

## Why

源码核对发现三个连续门槛：cloudflare-graphql.ts 的 discoverZone 仅在 Action 和等于 rawTotal 时给出 blockedTotalEvents；suppression.ts 的 decideSuppression 将原始/过滤计数差异直接判 degrade；waf-analyzer.ts 遇 degrade 提前返回，并在 zoneTotalEvents=0 时清空所选 Host。process-alert.ts 随后走无 Incident 的基础模板。现有测试明确固化了这种旧行为，修复需要显式修改规范与回归断言。

## 目标

- 只让满足观察静默条件的快照跳过 AI/企微并 ack；保留用户接受的 Adaptive 稀少事件遗漏风险。
- 区分静默资格、可用 Host、分母可比性和真实协议失败；普通估计差异不丢弃可靠 Host。
- 过滤始终排除严格 action === "block"，未知动作不得默认为 block；恢复多 Host 通知及可定位质量日志。

## What Changes

- **BREAKING（旧业务判定）**：替换“聚合不一致即整体基础降级”和“blocked 必须等于 raw”的前置门槛。
- 使用确定性判定表处理 suppress、continue、raw_empty、无可用 Host 和 collection_failed；差异原因与比例可用性独立携带。
- 原始未知 Action/截断只否定静默，不否定已校验的过滤后 Host；不可覆盖范围必须说明。
- Zone 比例不可比较时为 null，保留 Host 可靠计数、同范围统计、Evidence 与局部 AI 结果。
- 增加受控判定日志，保持终态 ack、固定窗口、同文本通知重试和字节预算。

## 非目标

不修改过滤策略、规则来源判断、IP 黑名单、Queue wire、bindings、依赖或云资源；不增加存储、轮询、第二轮业务采集或 LLM 自主静默。本次获准按tasks修改生产与测试代码，仍不提交、推送、合并、部署、同步 Specs 或归档。历史备份文档不修改。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `blocked-event-suppression`：静默资格、保留部分数据、诊断。
- `host-scoped-alert-analysis`：Host 选择、分母可比性、局部故障、通知预算。
- `waf-snapshot-analysis`：上下文与有效统计分离。
- `wecom-alert-notification`：有可用 Host 时不得整体替换为基础异常。

## 影响范围

Client/响应标准化、event-scope/analysis-result/host-analysis 契约、判定纯函数、Analyzer、Host Statistics/Findings/Evidence、AI 输入构建、Host Formatter、Pipeline 诊断及对应 Workers 测试。具体文件、接口与测试映射见 design/tasks。既有 AI wire v3/Catalog v2 及封闭输出、证据归属/支持条件、字节预算继续生效；Webhook 与 Queue wire 不变。

## Impact

主 Specs 当前为空，四项均按前序已确认 Change 的同名 Requirement 写 MODIFIED，不冒充新增能力。本 Change 显式覆盖 suppress-blocked-alert-events 的原始Action守卫段落以及“任一不一致在 Host/AI 前整体降级”场景；保留过滤、协议校验和 Host 内质量校验。同步依赖为 MVP → optimize-llm-analysis / structured-evidence-references → host-scoped-alert-analysis → suppress-blocked-alert-events → 本修复，需另行授权，不能跳过前序规范基线。

AGENTS.md 的“无工程/无正式Change”属于历史描述，源码、package.json 与五个活动 Change 已存在。需求/技术文档与既有 MVP 的单环境约定和 AGENTS 的双环境规则有差异；本修复不调整环境或授权任何部署。

## 风险与兼容性

继续接受采样遗漏风险，不使用任意百分比容差或完整覆盖证明。未知 Action 的底层否定过滤语义仍未证实，仅保留已返回且通过同范围校验的数据。独立正数差异不等于查询失败，但零/正冲突、正非block证据、未知/截断必须阻止静默。保持 policyId=exclude-exact-block-v1，日志另加 decision_version=aggregate-quality-v2 便于区分判定版本；不新增 Queue 策略快照。回滚本修复到上一版会恢复整体降级缺陷，不会恢复更早的未过滤明细；回滚需另行授权。

## 验收标准

design 中 A1–A16 逐项映射到 tasks，覆盖全block计数差异静默、混合计数差异保留 Host、零Zone正Host、无Host非block证据、未知/截断、同实体混合动作、局部失败、协议失败、空窗口、窗口/重试/日志终态、五Host字节预算。实现完成必须有失败到通过的测试证据、Workers集成、typecheck/lint/test、本地 Wrangler dry-run 与 GitNexus 完成检查；规划校验已完成，实施验证证据记录于verification.md。

## 基线与发布依据

分支：`fix/preserve-host-analysis-on-aggregate-mismatch`；基线：`43184576da99b5bdc01b978cb15ec6d70fed03c1`。2026-10-09用户明确确认该提交为上一版“已拦截事件静默”的实际发布提交；本次未独立查询Cloudflare部署元数据。已核对该提交包含实际过滤、静默及多Host代码，分支从该SHA直接创建。

Change：`preserve-host-analysis-on-aggregate-mismatch`，通过 `openspec new change` 创建。用户本轮确认仅确认发布基线，不代表批准本修复artifacts或授权实现。

初始工作区干净，无暂存或未跟踪修改；远端通过 git ls-remote 实时核对。origin/master 为 44e66587a97662865d1ebe2b3e9f9dd731c84d80，是基线祖先，左右提交差为 0/9，无分叉；差异覆盖 Webhook、LLM、结构化证据、多Host与静默能力（141 files，10082 insertions，1149 deletions）。不从落后的远端master起分支，不合并、不覆盖。前序静默提交相对父提交变更56文件，并含本次已核对的真实过滤/静默代码；发布确认与源码存在分别记录，不以分支名代替发布依据。

## 规划校验记录（2026-10-09）

- `openspec status --change preserve-host-analysis-on-aggregate-mismatch`：4/4规划artifacts齐全；这不是实施完成或用户批准。
- `openspec validate preserve-host-analysis-on-aggregate-mismatch --strict`及`openspec validate --all --strict --no-interactive`：通过；全量6项通过、0失败。四项MODIFIED目标主Specs缺失提示仍在，按上述前序依赖同步后方可归档，当前不执行同步/归档。
- 仓库工作流脚本针对本Change：通过。根级调用会将`changes/archive/`容器误识别为Change，产生4条OSWF002/OSWF003；不修改脚本，改为逐个实际活动Change校验，6项均通过。
- 规划审计：7个Markdown文件，4项delta同名Requirement均来自前序已确认规范；无占位符、无已勾选实施任务；未修改任何已有跟踪文件，HEAD仍为基线提交。
- 本次只创建分支与规划文件；未执行typecheck/lint/行为测试/Wrangler dry-run，未刷新或冒称完成GitNexus图验证。这些均列入批准后的实施任务，不把历史测试结果算作本修复通过证据。
