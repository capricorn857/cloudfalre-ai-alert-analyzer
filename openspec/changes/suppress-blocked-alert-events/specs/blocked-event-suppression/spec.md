## Purpose

定义固定窗口内按精确 Action 排除已拦截事件的范围契约，以及基于可信查询与数据质量执行正常静默、保守降级和可追溯确认的行为，拒绝有限样本/TopN或外部失败冒充聚合零；采用用户明确接受采样遗漏风险的Adaptive观察策略。

## ADDED Requirements

### Requirement: Exact event-level blocked exclusion
系统 MUST 仅排除原始 Action 严格等于 `block` 的事件，覆盖自定义与托管规则；MUST 不查询黑名单或按IP、Host、规则整体排除。非block、未知、缺失或无法判定Action MUST 不默认block；非block MUST NOT 被解释为攻击成功、绕过全部防护或请求到达源站。无法可靠保留不可判定事件时 MUST 受控降级而非静默。

#### Scenario: Custom and managed rules
- **WHEN** 自定义规则与托管规则分别产生精确block事件
- **THEN** 两者均不进入待关注统计、AI Evidence或企微事件明细，不因首次攻击或可能误拦截例外通知

#### Scenario: Same IP mixed actions
- **WHEN** 同IP或Host同时有block、allow、managed_challenge事件
- **THEN** 仅删除block事件，剩余事件继续分析，不静默整个IP、Host或Zone

#### Scenario: Missing unknown and noncanonical actions
- **WHEN** Action为null、缺失、未知字符串、空串、BLOCK或带空白的block
- **THEN** 不归为精确block；语义可保留时进入待关注范围，违反外部契约时数据降级，不计为零

### Requirement: Verified query-side attention scope
系统 MUST 在发现和选择Top Host之前，以已验证的查询谓词排除block；所有待关注总量、Host聚合、维度、样本、Findings、AI Evidence与通知 MUST 采用同一范围。两dataset否定/精确比较与字段能力 MUST 有目标证据，底层未知保留无法证实时 MUST 用无过滤原始Action分布的确定性守卫保证观察不可信即降级；不支持时 MUST NOT 回退到有限样本/TopN删除或已知Action白名单。

#### Scenario: Blocked hosts dominate original ranking
- **WHEN** 原未过滤Top Host均为block而其他Host有非block事件
- **THEN** 后者能按过滤后的排名进入Host名额，不被原始TopN排除

#### Scenario: Filter capability unavailable
- **WHEN** 运行时原始Action分布不可判定、截断或不一致，或过滤返回不支持
- **THEN** 不推测语法、不当作零；在Host采集和AI前发送基础降级通知，禁止默认未知事件为block

### Requirement: Trustworthy suppression decision
系统 MUST 由确定性逻辑决定静默，LLM不得决定。只有有效全Zone固定窗口查询确认原始总量>0、待关注总量=0、直接block计数等于原始总量、过滤Top Host为空，且响应完整、计数内部一致且可比较、无已知质量冲突，才 SHALL 返回 `suppressed/no_attention_events_observed`。observationBasis MUST 为adaptive_aggregate并携带采样风险说明；用户于2026-10-09接受稀少非block可能遗漏，采样或采样状态未知本身 MUST NOT 阻止静默。计数相等仅为一致性检查，不是统计完整性证明；有限样本、TopN覆盖或显示100.0% MUST NOT 作为静默依据。

#### Scenario: All blocked with eligible quality
- **WHEN** 所有上述查询及质量条件满足
- **THEN** 不调用LLM、Formatter或企微，产生独立静默结果并正常ack

#### Scenario: Adaptive observed zero with accepted sampling risk
- **WHEN** 有效全Zone固定窗口查询满足raw>0、attention=0、直接blocked=raw、Top Host为空及全部协议/一致性条件，但采样已发生或采样状态未知
- **THEN** 静默且不调用LLM、Formatter或企微，reason为no_attention_events_observed；日志标明adaptive_aggregate及采样风险，不宣称绝对不存在非block请求

#### Scenario: Samples and rounded percentages cannot prove zero
- **WHEN** 有限样本全block、已选Host全block，或block比例舍入显示100.0%，但全范围待关注聚合仍为正或未知
- **THEN** 不整条静默；按可信剩余聚合分析，污染样本不可用时局部降级

#### Scenario: Inconsistent or incomplete discovery
- **WHEN** 计数冲突、缺alias、部分data、非空errors、原始计数未知或待关注零但Top Host正
- **THEN** 不将失败或缺失映射为零，不静默，保留明确降级原因

### Requirement: Distinct raw empty and failed outcomes
系统 MUST 区分 `raw_window_empty`、`no_attention_events_observed`、过滤/查询失败及静默质量不足。有效原始零且其他计数零、排名为空 SHALL 保留数据不足通知；失败或不可信零 SHALL 发送基础受控降级通知，不调用LLM生成数据结论，不重采窗口。

#### Scenario: Original empty window
- **WHEN** 有效原始总量、待关注总量、原始Action分布中的block计数均零且排名为空
- **THEN** 发送原始窗口未查询到数据的通知，结果为empty而非no_attention_events_observed，不调用LLM

#### Scenario: Query failed
- **WHEN** 超时有限重试耗尽、无效响应或过滤不支持
- **THEN** 发送不含伪造统计或未过滤明细的基础异常通知，保留具体失败码，不标为原始空或全部block

### Requirement: Suppression lifecycle and safe diagnostics
静默 MUST 是正常业务终态，MUST ack且不主动Queue重试，不得记为企微发送成功。日志 MUST 包含静默原因、策略标识、范围、可信计数及质量、incident_id、correlation_id、analysis_window；MUST 不含原始响应、Credential或事件实体。日志失败不得改变静默结果。现有固定窗口、至少一次投递、AI局部降级、企微同文本有限重试及发送后不重放 MUST 保持。

#### Scenario: Suppression logger fails
- **WHEN** 已决定静默后日志抛错
- **THEN** 返回suppressed、ack=1、retry=0、LLM及企微均未调用，未记录notification_sent或success发送类别

#### Scenario: Delivery is repeated
- **WHEN** Queue重复投递相同消息
- **THEN** 复用固定窗口及配置，不宣称exactly-once或已持久化幂等，不因静默主动请求重放

### Requirement: Fixed policy compatibility
本策略 MUST 使用固定标识 `exclude-exact-block-v1`，不新增env开关或Queue字段。新Consumer MUST 对合法新旧v1消息应用该策略且保留原窗口与已有配置快照；整包回滚 SHALL 恢复旧版本行为并说明block通知可能恢复，不能承诺跨版本策略快照或回补历史静默。

#### Scenario: Historical queue message
- **WHEN** 新Consumer收到合法旧v1消息，包括缺hostLimit而适用既有默认值的消息
- **THEN** 应用同一固定静默策略、保留消息原始窗口，不从当前时间或env重算

#### Scenario: Rollback
- **WHEN** 另经授权回滚整个旧版本
- **THEN** Queue结构仍兼容，旧版本恢复原分析通知，运维说明重复和block噪声风险，不迁移删除消息

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。

#### Scenario: Raw action distribution cannot establish attention scope
- **WHEN** rawActions触及20分类、重复分类、加总不安全、sum不等于rawTotal、非block和不等于attentionTotal，或出现正计数null/缺失/空串分类
- **THEN** blockedTotalEvents在分布不完整时为null，Host采集与AI均为0，基础降级通知说明范围不可靠，不静默或回退未过滤明细
