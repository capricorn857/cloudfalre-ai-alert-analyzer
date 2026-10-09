# 设计说明：聚合差异时保留 Host 分析

## Context

基线与发布确认见 proposal。现有调用链为 discoverZone → decideSuppression → analyzeHostWafAlert → analyzeHost / summarizeCoverage → runHostAIAnalysis → formatHostWeComMessage → notification.send。旧判定在 Host 采集前返回 degrade；Client 也以 sum(rawActions)=rawTotal 判断分布完整；Analyzer 额外把 zoneTotalEvents=0 映射为空 Host 列表。三者必须一起修复。

## Goals / Non-Goals

目标是让静默安全性与分析可用性独立，同时保持严格逐事件过滤、确定性统计和原多 Host 消息结构。无新外部查询能力、无新持久化、无 Queue schema/binding 或部署变更。

## 总体方案

一次固定窗口发现返回经 Zod 校验的观察事实，再由纯函数产生决策与质量元数据；按可用过滤后 Host 继续原有限采集流程。仅静默直接结束；无可靠 Host 则发送已知事实/范围不足或真实查询失败通知。

## Decisions

### 方案取舍

| 方案 | 取舍 | 选择 |
|---|---|---|
| 静默资格、Host可用性和分母可比性分别建模 | 明确边界，保留数据；需贯通领域、证据、通知与日志 | 推荐 |


### 判定表（按优先级匹配）

前提：严格使用 Queue 的 Zone/start/end；HTTP成功、GraphQL无errors、关键alias完整、Zod类型/计数合法。T=过滤后Zone总量，R=原始总量，H=有效正计数Host列表；Action分类完整仅指未触limit20、类别不重复、计数/加总为安全整数，不证明采样完整。未知类别包括 null、缺失、空串；未知非空字符串、BLOCK、block空白变体是明确非block。Top Host必须原数组为空才符合静默，零计数条目不能冒充空数组。

| 优先级 | 观察 | 决策 | Host/AI/通知 |
|---|---|---|---|
| 1 | 请求失败、HTTP200 errors、关键alias/Zone缺失、非法计数/unsafe和、范围协议错误 | collection_failed，基础异常 | 不采信同一失败操作的部分data；零AI，发送失败码 |
| 2 | T>0 或过滤Top Host任何正计数；H非空 | continue；有质量问题则partial | 按H选择/采集；仅可靠Host进入AI；单条多Host通知 |
| 3 | 存在已知正计数非block或T>0或正计数无效Host，但H为空 | no_usable_hosts，基础范围不足 | 零AI；展示独立已知观察及“未取得可用Host明细” |
| 4 | 未知Action、Action截断/重复、R与Action零/正冲突、T=0而原始已知非block正、非空零计数Top列表等否定静默条件，且无H | suppression_ineligible，基础降级 | 说明具体原因，零AI，不猜测Host |
| 5 | R=0、T=0、Action无正计数且无未知/截断/重复、Top数组为空 | raw_empty | 数据不足通知；零AI |
| 6 | R>0、Action非空完整且无不可判定类别，至少一个正计数block、所有正计数类别仅精确block；T=0，Top数组为空，无其他否定证据 | suppress | AI0/Formatter0/企微0，正常ack |
| 7 | 其他有效但不足的观察（如R>0但Action空或全零） | suppression_ineligible | 基础范围不足，不伪静默 |

第2行优先于原始上下文质量问题：无论未知、截断或原始比较冲突均保留通过校验的过滤后 H；只有协议失败（第1行）不复用该失败发现响应。未知/截断而有可靠H必须partial并说明未知范围未被可靠覆盖。R=0但有正数Action/过滤结果不是原始空窗口。

### 可容忍差异与语义矛盾

- 独立正数估计之间 R≠sum(rawActions)、T≠已知非block和（双方均正）、block>R、T>R：记录比较来源/值和原因，不要求相等，不据此丢Host。不引入任意比例阈值。
- R=1360、block分组1362、T=0、Top空且Action仅block：满足第6行，仍静默；blockedTotalEvents必须保留直接1362估计，不能因和≠R置null。
- 零与正数冲突：R=0却有正Action、R>0却Action无正数、T=0却非block或Host为正；这些不是“仅正数估计差异”，必须阻止静默。保留可用H，不能以冲突推断谁的计数正确。
- 原始Action未知/截断/重复：不能断言全block；这不是整个过滤范围失效的充分证据。有H继续，没有H基础降级。
- 负数/非整数/超安全整数、关键响应缺失、errors或过滤返回block污染不是容差问题。发现关键协议无效则collection_failed；Host聚合污染仅该Host失败，样本污染仅样本集合失败。

## 组件与边界

| 文件/符号 | 规划修改 |
|---|---|
| src/clients/cloudflare-graphql.ts discoverZone | 分布结构完整性与跨alias相等解耦；直接block估计不做相减；保留已校验观察 |
| src/clients/cloudflare-graphql-schema.ts | 保持缺字段/errors拒绝；缺失Action明确标准化unknown，不把缺alias默认零 |
| src/domain/event-scope.ts | Zod定义DiscoveryQuality和分支决策；计数安全、完整性与可比性独立 |
| src/analysis/suppression.ts decideSuppression | 实现表格；纯函数返回kind及受控reasonCodes/比较结果，不能仅返回aggregate_inconsistent |
| src/domain/analysis-result.ts、src/domain/host-analysis.ts | 快照携带判定质量；partial有Incident；无Host原因和原始空区分 |
| src/analyzers/waf-analyzer.ts | 仅suppress提前静默；取消T=0强制清空H；局部失败隔离 |
| src/analysis/host-analysis.ts、statistics.ts、rules.ts | Host局部统计不依赖raw；Zone可比性显式输入；不可用比例null，不伪造Finding |
| src/analysis/host-evidence.ts、src/domain/host-evidence.ts、src/analysis/ai-analyzer.ts | 传播经验证质量；Zone不可比较不导致可靠Host目录整体失败；原始上下文不作攻击证据 |
| src/notification/host-formatter.ts、blocks.ts | 保留Host结构和受控质量提示；实际Action计数/比例而非固定allow/challenge概括 |
| src/pipeline/process-alert.ts、src/observability/logger.ts | 决策/实际外部调用状态日志，异常隔离，不改变Queue终态 |

不改 index.ts 业务职责、fetch路由、生产配置或 Cloudflare 资源。所有新内部字段camelCase，日志snake_case。

## 数据与接口契约

拟新增 `DiscoveryQualitySchema`：reasonCodes（封闭枚举数组）、actionDistributionTruncated、unknownActionCount、rawActionCountSum、knownNonBlockCountSum、filteredTopHostCount、filteredTopHostCountSum、zoneDenominatorComparable、invalidRatios、comparisons。comparisons仅固定比较枚举和值/结果，不装原始响应；安全加总失败时字段null并附原因，不能溢出。

`decideSuppression(input: ScopedDiscovery): SuppressionDecision` 的kind为suppress/continue/raw_empty/degrade；continue携带quality且不承诺AI可用，degrade仅用于无可用Host的降级。协议失败仍由Client/Analyzer映射collection_failed。所有非失败快照附quality；no_usable_hosts作为稳定原因区别raw_empty。Analyzer/Formatter不得自己重新决定静默。

`analyzeHost` 与 `summarizeCoverage` 显式接收经判定的Zone分母可比性（而非仅数字T）。`buildHostEvidenceCatalog` 输入包含相同质量投影，AI与Formatter重建目录必须一致；质量元数据只能收紧支持资格，不能绕过既有Schema与来源验证。Zone总量0作为真实观察保留，但不可作为正Host比例分母，不把Host/Zone大小关系写成根目录失败门槛。

### 比例可用性矩阵

| 情况 | Host内比例/速率/样本 | zoneShare与覆盖 |
|---|---|---|
| 仅原始R/Action正数估计差异；过滤Host自身一致 | 维持原同范围计算 | 过滤发现、细查及覆盖条件满足可用；raw差异不污染分母 |
| T=0且Host正；Top Host计数和>T；过滤总量与可靠已知非block计数不一致 | Host内部一致结果保留 | null；保留T为观察值，不补总量 |
| 原始Action未知/截断/重复，覆盖范围不能可靠比较 | 可靠过滤Host内部结果保留，未知范围说明 | 保守null，不能声称覆盖全部待关注事件 |
| Host discoveryCount≠hostTotalEvents | Host细查内部一致比例、固定窗口速率仍可用 | 该Host zoneShare=null，整体coverage=null；其他Host是否可比较按自身条件判断 |
| Host某维sum>hostTotal、Action/Source截断或sum不等于hostTotal | 受影响维度比例null；计数/明细保留，规则不得用未知比例命中 | 按既有质量条件不可用时null |
| Host样本失败 | 聚合可用；UA比例未知；不补样本 | 聚合可靠且发现可比较时不因单纯样本失败丢覆盖 |

Top IP/Path/Country/ASN为有限TopN，sum小于Host总量本身不是错误，不要求TopN完全覆盖。Action/Source完整分布仍要求未截断且sum=Host总量才给分布比例。Host内部使用hostTotal，Zone占比/覆盖只用T；raw/Payload绝不作替代分母。不可比较相关比例为null，通知“未知”，不clamp/强归一/补齐；可靠计数保持原值及来源。

## 错误处理

范围污染按操作隔离；单Host聚合失败保留发现数并明确非细查总量，样本失败保留可靠聚合，AI缺失/无效只降级该Host；根模型请求失败仍使AI整体不可用但所有Host规则/明细保留。AI结构、跨Host引用、证据支持、封闭输出不可放宽。静默由程序，不交LLM。

GraphQL正常预算不变：1+2H HTTP、4+8H nodes，H≤5，最大并发2、90秒共享截止；最多2次技术重试为33 HTTP/132 nodes。有效空数组按已核验响应契约映射零，null/缺alias不能。无追加业务查询、无第二轮采集。

### 受控原因与日志

受控原因至少包括：
`raw_action_sum_mismatch`、`attention_action_sum_mismatch`、`raw_zero_positive_evidence`、`raw_positive_no_action_evidence`、`attention_zero_positive_host`、`attention_zero_positive_non_block`、`top_host_sum_exceeds_attention`、`action_unknown`、`action_distribution_truncated`、`action_distribution_duplicate`、`nonempty_zero_top_hosts`、`no_usable_hosts`、`host_discovery_count_mismatch`、`zone_denominator_unavailable`、`raw_window_empty`、`no_attention_events_observed`；失败保留既有具体外部error_code，不收敛为笼统不一致。

日志包含incident_id/correlation_id/analysis_window/queue_attempt（沿Queue上下文）、policy_id、decision_version、final_decision（suppressed/continue_analysis/partial_degradation/basic_exception）、全部原因码、raw/attention/block直接计数、受控Action分类计数、分布是否截断、未知Action计数、Top Host数量/计数和、每个不一致比较、invalid_ratios及AI/企微实际调用状态。raw_empty与no_usable_hosts用独立reason区分，即使均属基础结果。

Action日志用封闭已知类别加other_non_block/unknown分类计数，未知原字符串不进入日志；不记录Host原字符串、IP、路径、Webhook地址、Token、模型原文、大型响应。计数只来自校验过数据，失败不可填0。开始决策日志记录尚未调用，终态日志记录ai_called/wecom_called与发送结果，不能用计划调用冒充实际调用；静默无notification_sent。日志catch边界覆盖前后，不影响静默或已成功通知ack。

## 通知结构与预算

保留：标题/Zone/过滤后快照事件数及“已排除action=block” → 中文编号Host块（事件数、Zone占比、该Host真实Action分布、必要降级提示、来源IP/目标路径/国家地区/ASN/触发来源）→ 集中人工核验建议 → 有合法建议时独立AI建议 → 固定限定语、告警时间、分析窗口、数据截至、覆盖、完整关联ID。

T=0但Host正时显示“过滤后Zone聚合观察0，与Host发现冲突”，不能写“窗口无事件”；比例/覆盖未知。有原始非block证据但无Host时，展示明确标为原始上下文的已知计数，不伪造过滤后数量或攻击结论。Unknown/截断范围提示为必需块，不允许裁剪后仅剩无条件判断。不得输出“本Host全部标记为block”，不为已过滤block产生核验IP建议；同IP剩余非block仍可支持既有合法建议。

使用既有assembleBlocks与2000 UTF-8 bytes预算，保留全部选中Host最小状态、必要限定语、固定窗口和完整ID；必要时短Host标识/整块省略细节，标注省略，不拼接半实体。新ID上限及历史超长ID受控失败规则不变，不为适配预算偷删ID。AI wire v3/Catalog v2，每Host64项/10KiB、全体328项/56KiB、messages64KiB/body96KiB/content32KiB/response128KiB边界不变。

## 兼容与恢复

保持exclude-exact-block-v1过滤策略及合法新旧Queue v1消息；decision_version仅日志版本。企微有限重试重用同一最终文本，不重跑GraphQL或AI。至少一次投递仍可能重复，不承诺exactly-once。静默与发送成功后日志失败正常ack。未授权不提交、合并、推送、部署、同步/归档。另获授权回滚整个修复包到4318457将恢复旧全局降级，不更改消息窗口或迁移数据。

### 与前序规范的显式冲突与同步依赖

本Change四个delta共同替换上一版各文件末尾重复的“运行时Action保留守卫”：删除其中sum(rawActions)=R、非block和=T、blocked=R作为全局继续分析/静默先决条件的语义；保留计数合法、未截断/无未知的静默门槛与严格过滤。对“原始Action不可判定/截断/不一致→Host/AI均0”和“计数不一致→基础通知”明确改为优先保留可靠H。仅对应受影响Requirement全文覆盖，不修改前序历史文档。

未来同步需先按proposal列出顺序建立前序主Specs；同步本delta时将旧重复守卫段落删除或替换为本判定表引用，避免主Specs同时保留互斥规定。当前主Specs为空导致MODIFIED-target提示是已知同步依赖，不代表已同步。

## 外部能力证据与限制

2026-10-09本轮只复核仓库脱敏证据与公开文档，未读取Secret或执行live GraphQL/LLM/企微。test/fixtures/graphql/blocked-action-schema-contract.json证明当时目标两dataset存在action_neq/AND/OR、目标settings及四alias接受，精确大小写/空白对照的聚合结果已有记录；null/null_neq/含null OR返回errors，不能加入action:null。旧runtimeProtection字段描述旧守卫，实施时更新该说明但不得改写历史观测结果。

仍待有权限的目标固定窗口非空对照验证：混合事件过滤先于TopN的真实结果、样本dataset非空Action否定语义、底层null/缺失/空串编码与保留。未知保留不能从string!或空结果推断；不要求绝对覆盖证明，不以无法证明底层null为阻止所有可靠Host分析的门槛。离线对抗测试覆盖已观察未知→非静默和保留可靠部分，外部核验只读且另行明确范围；无法得到非空证据如实保留限制，不宣称验证通过。

公开资料：[Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/)说明Adaptive返回估计；[Filtering](https://developers.cloudflare.com/analytics/graphql-api/features/filtering/)说明运算能力随字段变化。它们不证明本dataset底层null被否定过滤保留。本决策是用户确认的风险策略，不冒充Cloudflare完整性保证。

## 测试计划

| 编号 | 输入/故障 | 必须断言 |
|---|---|---|
| A1 | 全block且计数一致 | suppressed、AI0、通知0、ack1 |
| A2 | R1360/block1362/T0/Top空 | suppressed；直接block估计保留，原因记录差异 |
| A3 | 有非block、原始正数计数不一致 | Host采集/明细保留，非基础告警；可靠Host可AI |
| A4 | T0/正Host | 不静默，多Host结构；zoneShare/coverage=null |
| A5 | 原始Action非block正/Top空 | 已知事实与无可用Host；AI0，不伪原始空 |
| A6 | 同IP同Host有block与其他Action | 逐事件排除block，非block统计/样本/Evidence保留 |
| A7 | 原热门Host仅block、其他Host非block | 先过滤后TopN，后者入选 |
| A8 | null/缺失/空Action，有Host/无Host | 均不静默；有可靠Host保留且说明未知范围，无Host基础降级 |
| A9 | Action达到20分类或重复 | 不断言全block；有Host继续 |
| A10 | 单Host聚合/样本/AI失败 | 其他Host保留；聚合与样本污染同操作隔离 |
| A11 | GraphQL失败/errors/关键缺失 | 不把部分失败data当成功，不填零 |
| A12 | 有效原始空、观察零、部分可用 | 结果/文案/日志互不混淆 |
| A13 | 空/低量/重试 | Queue固定窗口字符串不变，无新业务轮次 |
| A14 | 企微临时失败 | 同文本有限重试；不重跑GraphQL/LLM |
| A15 | 静默或发送成功后logger抛错 | ack1/retry0；静默无notification_sent |
| A16 | 五Host、长字段、完整ID | ≤2000 UTF-8 bytes；所有Host最小状态/限定语/窗口/ID完整 |

额外对抗：raw0却正Action、raw正但Action空/全零、Top仅零条目、unsafe和、重复Host协议错误、T>R的正数差异、Top和>T、Host发现600/细查610、跨Host引用与伪造分母继续拒绝。Workers测试运行于既有@cloudflare/vitest-plugin，不用普通Node替代bindings验证。

## 规划期影响检查

已运行gitnexus status/list：master索引停ce86425，上一静默分支槽停483eaa5，均早于基线4318457，不可作为本修复完整图证据。本次以源码/rg追踪上述调用链，不声称已完成GitNexus影响分析。实施首任务刷新新分支索引并对共享符号逐项impact；HIGH/CRITICAL核对本design范围、调用方和测试，越界先更新artifacts。实现与测试后必须detect-changes --scope all。

## Risks / Trade-offs

- [估计差异被误当作可靠比例] → 质量判定与保留明细分开，逐项记录不可用比例，不增加容差。
- [未知Action未被底层否定过滤保留] → 观察到未知即禁止静默，可靠部分继续且明确未知范围；不声称完整覆盖。
- [质量提示挤占通知预算] → 必需状态与限定语优先，整块裁剪低优先级明细，五Host压力测试。
- [过期图索引漏调用方] → 实施前刷新并结合源码核对，完成后detect-changes；规划不冒称图验证通过。

## Migration Plan

本次创建draft artifacts并等待确认。后续经批准实施时同包更新领域质量契约、Client/Analyzer、Evidence/AI投影、Formatter与日志，执行全部离线门禁；不迁移Queue或配置。发布需另行明确授权，届时按既有发布流程核验；回滚到已确认基线恢复上一版行为及其已知全局降级缺陷。

