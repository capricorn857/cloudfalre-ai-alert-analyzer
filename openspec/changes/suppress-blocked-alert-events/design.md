# 设计说明：已拦截事件静默

## Context

基线为 master 483eaa5。`discoverZone` 当前查询未过滤 total 和 Top10 Host；`collectHostSnapshot` 每 Host 查询7个聚合 alias及1个样本 node。`analyzeHostWafAlert` 先选 Host，再以两通道采集，90秒共享 deadline；`processHostAlert` 无条件进入 AI 与 Formatter/通知路径。`handleQueueBatch` 对处理正常返回 ack，异常才 retry。

主 Specs 为空，但 MVP proposal 为 approved，host-scoped/structured-evidence/optimize-llm 为 implemented。以这些已确认 Change 为契约基线，不覆盖它们。`test/fixtures/graphql/host-schema-contract.json` 仅证明2026-09-24目标 Host/time filter、字段和旧7 alias形状；没有 Action 否定、null 语义、零结果采样证明。GitNexus 索引停在 ce86425，本轮仅人工追踪调用链，图风险未完成核验。

## Goals / Non-Goals

目标是事件级过滤前置，并把“有事实可分析”“可信静默”“不可信/无数据降级”建模为不同结果。保留固定快照、模块边界和现有 AI 支持约束。不枚举全 Zone、不建完整日志系统、不引入可热更新策略配置、不改变 Handler/Queue wire 契约。

## 总体方案

推荐流程：已固定 Queue 窗口 → 一次发现请求（原始总量、待关注总量、原始Action分布、待关注 Top Host）→ 纯函数判定 → `suppressed` 正常结束，或过滤后的有限 Host 采集/统计/AI/单条通知，或基础降级通知。

## Decisions

| 方案 | 取舍 | 结论 |
|---|---|---|
| 查询侧统一过滤，再选 Host | 不让 block 占名额，所有维度可共用谓词；依赖两 dataset 的实际过滤和零值契约 | 采用；目标能力证据及运行时守卫共同验收 |

### 1. 精确过滤及未知 Action

唯一排除条件是原始 Action 字符串严格等于 `block`。不 trim/lowercase，不查来源/IP名单；`BLOCK`、`block `、未知字符串、null、缺失值均不能当作 block。合法未知/空值标准化为显式不可判定分类，保留原始类别差异所需的受控元数据，不将数据畸形无限宽容为合法。

查询使用已实测接受的 `action_neq:"block"`，但不假定它保留底层null/缺失/空串。通过下述无过滤rawActions运行时守卫检测观察到的不可判定分类和分布不一致；不能可靠保留就提前基础降级，不用已知Action白名单。GraphQL非空声明和空查询均不是底层未知保留证明。

服务端过滤返回精确 block 时说明范围契约失效：该聚合操作不可用；样本操作丢弃受污染样本集合并标为失败，保留可靠聚合，不将过滤后少量样本冒充完整样本。缺失/未知样本 Action 应保留并使相应解释保守；null或缺失样本/Host Action可在可靠范围下标准化为unknown并保留有效信息；其余协议畸形受控失败，绝不转为零。同步修正现有统计/证据中 `toLowerCase()` 的 Action 归类，使 `BLOCK` 不再算作已拦截。

### 2. 查询计划、预算与能力门禁

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。全部使用同一Zone/start/end，禁止动态拼接实体。

每个选中 Host 的总量、Top IP/Path/Country/ASN、Action、Source 共7 alias，以及样本1 node均加入相同待关注谓词和 Host 精确条件。只改变过滤范围，不增加发现后的业务轮次；样本每 Host 默认50、最多100，Top四维10、Action/Source20，H=1..5默认3。最大并发2、正常HTTP仍1+2H（最大11），最多2次技术重试时33次尝试；正常 node selections 从2+8H变为4+8H，最大44，含重试最多132。发现失败/零值分支不发 Host 请求，静默正常只需1次HTTP/4 nodes。共享90秒硬截止含响应体、退避，过期取消在途且不继续请求。额外预算为发现阶段2个 alias、0个额外 HTTP；所需质量字段计入字段数限制。若必须另查质量信息，不能自动扩大预算，先修订 artifacts。

2026-10-09公开资料核对：官方 [Filtering](https://developers.cloudflare.com/analytics/graphql-api/features/filtering/) 说明 dataset 支持 AND/OR 及部分比较运算，但运算支持随字段变化；不能据此声称目标 Action filter 已验证。官方 [Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/) 说明 Adaptive 会按数据量采样并返回估计，不能据普通零结果证明未拦截请求不存在。

脱敏 `test/fixtures/graphql/blocked-action-schema-contract.json` 已记录目标introspection/settings、字段/限制和Action探测。能力验收采用目标API证据加确定性运行时守卫及Mock对抗测试：两dataset action_neq/AND/OR、大小写/空白语义及字段已核验；null filter/否定null/含null OR被拒绝，不要求不可实现的null查询，亦不声明底层null否定保留已证实。

2026-10-09目标booya.mx固定窗口2026-10-09T04:57:21.551930Z..2026-10-09T05:27:21.551930Z已接受最终四alias形状：raw378、attention[]、rawActions精确block378、topHosts[]。settings与形状预算已有证据；非空混合样本实测尚无，过滤先于排名和未知分布/污染由Mock对抗验证并明确限制。该全block实测不证明底层null、缺失或空串过滤保留，不证明Adaptive完整覆盖；运行时守卫遇见不可判定或不一致分布即失败关闭，不再依赖该保证。任务1.2/1.3需按这些验收条件验证并由实施者记录，本文不新增完成勾选。

### 3. 聚合观察零和业务决策

所有判定使用未舍入安全整数；HTTP成功、无 GraphQL errors、准确 Zone、完整必需 alias、经 Zod 校验为共同前提。有效空数组只有在目标契约明确表示无行时才能映射0；null、缺 alias、部分data、错误永远不是0。

`observationBasis="adaptive_aggregate"` 表示全Zone固定窗口Adaptive聚合观察，不表示未采样或完整覆盖。静默要求经校验的 `raw > 0`、`attention === 0`、直接 `blocked === raw`、待关注Top Host为空、无已知协议或聚合矛盾。计数相等只检查内部一致性，不提供统计完整性保证；Adaptive采样或采样状态未知本身不触发通知。用户于2026-10-09明确接受稀少非block事件可能未被观察并因此静默的风险。

| 输入状态 | 结果/LLM/企微 |
|---|---|
| raw>0，attention=0，blocked=raw，全部质量门槛通过 | `suppressed`，reason=`no_attention_events_observed`，LLM0/企微0，正常ack |
| 有效raw=0且attention=blocked=0、Top Host为空 | `empty`，reason=`raw_window_empty`，LLM0，发送“当前固定窗口未查询到事件/数据不足”基础通知；不宣称绝对无请求 |
| attention>0 | 只分析待关注范围，正常或局部降级通知；无论选中Host是否为空都不得全局静默 |
| attention=0但必需计数未知、协议不完整或计数不一致 | `suppression_ineligible` 基础降级，reason标明质量原因，LLM0/企微1 |
| 查询失败/无效/过滤能力不可用 | `collection_failed` 基础异常通知，保留具体errorCode，不调用LLM、不回退到未过滤明细 |

attention>0但全为无效 Host，或过滤后发现某 Host>0而细查变0：保留未覆盖/不一致状态，正常通知、不补位、不再查，更不能由所选Host和为0推断整个Zone为空。发现阶段原始Action分布或计数不一致时，在Host查询前整体基础降级，不把过滤结果继续交给AI；Host细查局部不一致沿用既有质量降级且不补查。发现响应协议无效则整体collection_failed。

### 4. 计数、比例和证据范围

`rawTotalEvents` 只作为原始上下文；`attentionTotalEvents` 是过滤后的 Zone 总量；`blockedTotalEvents` 是完整原始Action分布直接取得的计数，共享 `countQuality="estimated"`，不区分为精确计数；比较状态由判定函数及现有coverage结果派生，不要求未采样。Adaptive采样或采样状态未知本身不映射为incomparable/质量失败。采样限定在日志固定为sampling_limitation=rare_events_may_be_unobserved，在通知保留事件可能采样说明。不输出差值伪精确数，不把 Payload events_count 作分母。

现有 `zoneTotalEvents` 内部语义改为待关注总量，所有调用方同包迁移并显式携带 `eventScope="attention"`、`policyId="exclude-exact-block-v1"`；不允许改标签却继续传 raw。Host `hostTotalEvents`、发现计数、Top列表、Action/Source、样本、统计和 Findings 均为该 Host 待关注范围；zoneShare和覆盖分母为 attentionTotalEvents。UA分母为该Host待关注样本非空UA数量；速率为Host待关注总量/原窗口秒数。独立查询计数不一致时比例null，现有完整分布条件继续适用。

`buildHostEvidenceCatalog`、来源一致性验证、AI prompt和Formatter重建目录使用同一scope/policy。原始总量和直接 block 计数不进入可引用攻击证据；只允许作为程序通知/日志上下文，不提供 block 的 IP/Path/Source明细，不因此生成 review_source 建议。同一IP剩余的非 block事件仍可支撑建议。支持验证继续拒绝跨Host、错误分母、独立排名拼接关系；非 block、allow/challenge 均不等于绕过防护或到达源站。

保留Catalog v2和AI wire v3的封闭输出；为内部Catalog新增必需scope/policy并同步生成/校验，不扩大wire自由文本能力。旧目录缺标记拒绝，现有每Host64项/10KiB、全体328项/56KiB、messages64KiB/body96KiB/content32KiB/response128KiB、单逻辑LLM及局部降级不变。

## 组件与边界

| 模块 | 责任/具体影响 |
|---|---|
| `src/domain/event-scope.ts`（新增） | Zod定义过滤计数、质量、策略与判定联合类型，内部类型由Schema推导 |
| `src/analysis/suppression.ts`（新增） | `decideSuppression(discovery: ScopedDiscovery): SuppressionDecision` 纯函数，唯一静默决策 |
| `src/clients/cloudflare-graphql{,-schema}.ts`、`contracts.ts` | 已核验谓词和响应校验、直接计数、质量元数据；不执行业务静默 |
| `src/domain/host-analysis.ts`、`analysis-result.ts` | scope贯通、raw/attention分开、`suppressed`/`suppression_ineligible`结果 |
| `src/analyzers/waf-analyzer.ts` | 在selectHosts前判定、传递固定过滤scope和deadline |
| `src/analysis/{host-analysis,statistics,rules,host-evidence,ai-analyzer}.ts`及相关domain | 统一分母、Action精确语义、证据归属、局部降级 |
| `src/pipeline/process-alert.ts` | 在AI/Formatter前结束静默分支，安全日志，正常业务返回 |
| `src/notification/{host-formatter,templates,blocks}.ts` | 过滤范围说明和退化文案，预算保留 |
| `src/observability/{logger,errors}.ts` | 受控原因/状态/可信计数，禁止日志故障影响ack |

`src/index.ts` 不加入业务逻辑；fetch仅校验/窗口/入队，Queue Handler保留至少一次语义，只有必要的类型接入才调整。

## 数据与接口契约

新增 `ScopedDiscovery` 包含固定 `policyId`、`eventScope`、rawTotalEvents、zoneTotalEvents（即attentionTotalEvents）、blockedTotalEvents、共享countQuality=estimated、rawActions和过滤后topHosts。observationBasis及采样限定由Pipeline固定输出到日志，comparison状态由纯判定和coverage派生，不接受Client提供的可信声明。blockedTotalEvents在完整分布无法确认时为null；原始/待关注计数不可用时拒绝整个响应，不以默认0填补（已核验的有效空数组除外）。新增 `SuppressionDecision` 判别值为 `suppress | raw_empty | continue | degrade`，suppress只携带固定no_attention_events_observed原因；已校验计数保留于snapshot.discovery，Pipeline生成日志时附加Adaptive采样风险说明；Client不增加可变scope输入，使用固定策略生成全部查询及带scope的结果，所有Host结果必须继承同一scope。

`HostSnapshotAnalysisResult` 新增 `suppressed` 和 `suppression_ineligible` 变体，前者不伪造空 Incident；`processHostAlert` 对前者返回 `{status:"suppressed",snapshotStatus:"suppressed",aiStatus:"not_requested"}`，其余继续sent/notification_failed。受控降级直接走Formatter，不把不可用范围交给AI。

静默日志为 `alert_suppressed`，白名单含 `reason=no_attention_events_observed`、`policy_id`、`event_scope`、三计数、共享count_quality=estimated/比较状态/observation_basis=adaptive_aggregate及采样风险说明、incident_id、correlation_id、analysis_window、请求计数；queue_attempt保持Queue起始日志，按ID关联。`wecom_status=not_requested`、`llm_api_status=not_requested`，不写 `notification_sent` 或 response_category=success。错误路径保留外部service/error_code/failure_kind/duration等现有字段，不记录原始响应、样本实体或Secret。

## 错误处理

过滤/发现失败为基础降级，不执行未过滤fallback；Host聚合失败保留其失败块，样本失败保留可信聚合，AI局部错误沿用单Host降级。只对timeout/429/5xx等临时技术错误有限重试；HTTP200 GraphQL errors/Schema/鉴权/过滤不支持不可作为零，不额外业务重试。

静默结果先固定再best-effort日志，logger throw不抛回Queue。通知仍仅同文本阶段内最多2次重试，耗尽ack；发送成功后日志失败不重放。Queue至少一次投递可重复消费，不能承诺跨投递恰好一次或有持久化静默记录。

## 通知与既有规范冲突

必须明确“待关注事件（已排除 action=block）”，Action区改称“待关注事件处理分布”，不把过滤后block=0展示成防护失败。保留非block不等于攻击成功/到达源站、采样、独立排名、Top Host覆盖、质量/AI降级、窗口/时区、完整ID。原始计数可省略但显示时明确原始/估计，不能混成分母。2000 UTF-8 bytes不变，必要scope限定语纳入最小块预算。

| 既有来源/Requirement | 本delta的显式修改 |
|---|---|
| 需求FR-010、FR-012；wecom Required notification content / Empty and collection-failure messages | 可信no_attention_events_observed为不发送例外；原始空窗口仍通知，过滤零不冒充原始空 |
| host Fixed-window staged snapshot / Bounded host selection and configuration snapshot / Verified bounded GraphQL collection | 发现前过滤，Top名额取待关注范围，预算增加2个alias但HTTP不增 |
| host Host-owned statistics and quality / Honest coverage and isolated collection failures / Host-owned bounded evidence | 分母及证据scope同步切换，raw仅上下文 |
| host Mobile-readable single notification / Atomic notification blocks and byte budget | “所有选中Host”限定为过滤后选择、非静默通知；取消策略下全block Host防护详情，保留选中Host失败块 |
| waf Cloudflare GraphQL result contract / Incident normalization / Deterministic statistics | 区分计数与质量，过滤后统计一致；非静默才生成分析Incident |

上述修改完整复制既有Requirement后修订，保留未改变场景；本次不编辑主Specs或需求文档。未来正式同步先建立前序能力基线，再应用本delta。

## 兼容与恢复

无新增env策略开关、无Queue配置字段，固定策略标识为 `exclude-exact-block-v1`。现有v1消息（包括缺hostLimit的历史消息）继续原Schema/default解析；新Consumer对全部合法新旧消息执行同一策略，重试复用原消息窗口与已有配置快照。无跨发布策略快照保证，切换版本后的重复投递可按新策略处理，日志标识实际策略。

## Migration Plan

用户批准artifacts → 能力和GitNexus门禁 → 按tasks TDD实施 → 离线Workers验证 → 另行授权staging/发布。整包切换Client/领域/证据/AI/Formatter；不混用旧scope目录。回滚部署旧包恢复旧分析及通知，不迁移队列、不删除消息、不写资源；此操作仍需独立授权。回滚可能恢复block噪声且重复通知，不回补已静默历史事件。

## Risks / Trade-offs

- [Adaptive零值缺少完整性保证] → 用户已于2026-10-09接受观察零静默；稀少非block可能遗漏，日志只宣称未观察到待关注事件，不宣称全部事件已block。
- [不同alias/请求的估计不可比较] → 不相减、不虚构精确数，覆盖null；不得以计数相等代替完整性证明。
- [已拦截的新攻击/误拦截不可见] → 用户已明确接受，仍可人工通过Cloudflare查看；机器人不提供补报。
- [未知Action和旧lowercase逻辑] → 精确比较与反例测试，既有数据畸形走降级而非隐藏。
- [主Specs缺失/索引陈旧] → 显式前序依赖及实施门禁；本轮校验通过不等于可同步归档、API已验证或已获实施批准。

## 测试计划

见tasks验收矩阵：纯函数用完整合法/协议缺失或矛盾夹具；GraphQL集成验证每alias谓词及预算；Workers全链路验证LLM/企微调用次数、ack/retry、日志抛错。重点反例为TopN之外非block、同IP混合、缺失未知Action、样本全block而聚合正、显示100.0%但仍有剩余、仅独立采样数相等但缺attention，以及完整一致的采样零可静默。所有外部调用Mock；不运行live测试或发送生产机器人。

## 历史规划验证记录（2026-10-09，采样门槛已被同日新决策覆盖）

- 分支 `feat/suppress-blocked-alert-events` 从master 483eaa5创建，Change由 `openspec new change suppress-blocked-alert-events` 创建；既有两份未跟踪分享文档保留。
- `openspec status --change suppress-blocked-alert-events`：4/4规划artifacts齐全，不代表实施完成或获批。
- `openspec validate suppress-blocked-alert-events --strict`：通过；CLI提示三个MODIFIED目标主Specs尚不存在，当前无法直接归档，需未来经授权先建立前序主规范。此为已记录依赖，不通过重写ADDED规避。
- 仓库 `validate_openspec_workflow.py`：通过；proposal保持draft，实施任务全部未勾选。
- `git diff --check`：通过；未修改已有跟踪文件。未运行生产代码typecheck/lint/test、Wrangler或真实API验证，本次没有实现改动。
- GitNexus status显示索引陈旧，图影响与detect-changes安排在后续实施前/完成门禁，不报告本轮图分析完成。

## 实施核验更新（2026-10-09）

用户批准实施并再次确认不可判定Action保留或降级策略。当前目标能力与最终四alias只读证据及已知限制见上方能力记录及contract夹具；GitNexus当前分支影响检查完成，Evidence构建HIGH已复核在批准范围。历史记录不作为当前完成声明。

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
