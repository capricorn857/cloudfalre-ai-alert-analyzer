## MODIFIED Requirements

### Requirement: Fixed-window staged snapshot
系统 MUST 在Queue固定Zone/start/end/query_started_at下获取未过滤原始上下文、过滤后的待关注总量与Top Host，然后对有限Host采集。仅严格action="block"在发现排名前被排除；所有后续统计与明细使用同一待关注范围。只有blocked-event-suppression更新后的观察静默判定才可跳过Host/AI/通知；独立正数估计差异不能成为全局停止门槛。MUST NOT 移动窗口、轮询、补采或新增第二轮业务采集。

#### Scenario: Retain positive hosts at zero zone total
- **WHEN** 过滤总量0但Top Host有有效正计数
- **THEN** 继续这些Host的既有有限采集，不能因总量0清空选择；标记冲突，Zone占比/覆盖未知

#### Scenario: Identical retry window
- **WHEN** 查询技术重试或Queue再次投递
- **THEN** Zone与窗口字符串复用原消息，事件增长和空数据不触发新业务轮次

### Requirement: Bounded host selection and configuration snapshot
hostLimit MUST 为1..5整数默认3，producer写快照，合法旧Queue v1缺字段固定默认3，非法显式值拒绝，不以当前env覆盖。发现最多10项，按过滤后正计数降序/Host原值字典序选择非空Host，不穷举、不用失败Host补位。无效Host不替换为Zone或合并根域/www；过滤后正Host存在时即使Zone总量零或原始上下文未知也 MUST 进入候选。有非block证据但无有效Host MUST 通知范围不足。

#### Scenario: Partial or invalid host list
- **WHEN** Top中包含null/空Host、达到10项或有效项超过hostLimit
- **THEN** 仅采有效选中项并记录未覆盖/截断；不按数组长度声称总Host数，不由TopN为空断言Zone无事件

#### Scenario: Configuration remains a snapshot
- **WHEN** hostLimit=2的消息入队后env改为5
- **THEN** 最多分析2个Host，sampleLimit及窗口也沿用消息快照

### Requirement: Host-owned statistics and quality
系统 MUST 独立计算每Host Statistics/Findings/内部关注等级。Host维度与Action/Source比例使用该Host待关注总量；Zone占比及覆盖仅使用过滤Zone总量；UA分母为该Host已采有界样本非空UA数，速率分母为固定窗口秒数。rawTotal/Payload只作明确上下文，不替代分母。

Host内计数/明细 MUST 在可信时保留；相关分母零/无效、Host发现与细查不一致或覆盖不可比较时，对应比例 MUST 为null且展示未知，不补齐、clamp、归一或相减推算总量。仅raw正数估计差异不得污染已可靠过滤Host统计。T=0而Host正、Top和>T、过滤T与已知非block和不一致或未知范围未可靠覆盖 MUST 使Zone占比与覆盖不可用。发现/细查不一致只使相应Host zoneShare与整体覆盖不可用，内部同范围一致统计仍可用。

Action/Source完整比例 MUST 同时满足未触limit且sum=hostTotal；有限Top维度sum<hostTotal本身合法，sum超分母时该维度比例不可用。Action保持精确语义，未知不得计block；原始Zone统计不得作为Host攻击Evidence。

#### Scenario: Raw estimates differ but filtered data agree
- **WHEN** rawTotal与原始Action正数和不同，而过滤Zone、Host发现与细查均可比较
- **THEN** 保留Host内部统计和可比较Zone比例，附原始质量原因

#### Scenario: Zero denominator or discovery mismatch
- **WHEN** T0且Host正，或该Host发现600而细查610
- **THEN** 相关Zone占比和覆盖为null；可靠细查计数与内部比例保留，不追加查询

#### Scenario: Incomplete host action distribution
- **WHEN** Host Action/Source截断或计数和不等于Host总量
- **THEN** 保留已观察分类计数并标明不完整，对应比例null，不把分类和改作分母

### Requirement: Honest coverage and isolated collection failures
通知 MUST 展示实际已分析/失败Host数及可信覆盖；Host聚合失败不计为成功、不填零，样本失败但聚合成功可计入可信覆盖。一个Host质量、采集或AI不足 MUST 只降级其对应部分，其他Host明细继续。原始上下文不一致不能否定可靠Host；过滤范围不可靠时明确未知覆盖。Host细查总和超过Zone或发现不一致时覆盖比例 MUST null，有限排名不能推断全Zone无事件。

#### Scenario: One host failed
- **WHEN** h1聚合失败、h0成功、h2仅样本失败
- **THEN** 保留h0/h2聚合、h1失败状态及必要样本提示，不整体替换基础通知

#### Scenario: Unknown original actions
- **WHEN** 原始Action有未知或分布截断而过滤Host可用
- **THEN** 保留这些Host，说明未知范围未被可靠覆盖，Zone比例与覆盖未知

### Requirement: Mobile-readable single notification
非静默快照 MUST 保留单条中文编号多Host结构：标题、Zone/过滤总量与范围说明；每Host计数及Zone占比或未知、真实剩余Action分布、必要降级说明、IP/路径/国家地区/ASN/触发来源；集中人工核验建议与有合法内容时独立AI建议；排名独立/采样及非block不代表成功或到源站限定语；告警时间、固定窗口、数据截至、覆盖与完整关联ID。

所有选中Host MUST 有结果或最小失败状态，排序沿用HIGH/MEDIUM/Unknown/LOW、发现计数降序/Host字典序，等级只内部使用。标签统一中文，比例一位小数；维度标签独占一行，同类明细归组，IP/Path默认最多Top3、Country/ASN默认Top1，不重复摘要与Evidence或将建议穿插Top列表。独立排名不能拼成联合关系；攻击Unknown省略攻击类型，已校验Bot保留人工核验及自评非概率限定。Dashboard链接仍限制合法HTTPS dash.cloudflare.com且最长300字符，否则回退官网入口。无已校验AI建议不显示空标题；整体AI不可用时人工核验标题沿用“规则分析处理建议”。MUST NOT 输出“本Host全部标记为block”或为已过滤block生成核验IP建议。

#### Scenario: Mismatched context with multiple hosts
- **WHEN** 原始统计有差异但有可靠Host
- **THEN** 通知保留中文编号Host块及可用明细，必要质量说明不能整体替换为“数据口径不一致；AI不可用”

#### Scenario: Genuine remaining action distribution
- **WHEN** Host有log/skip/allow/challenge等待关注动作
- **THEN** 展示实际返回分类计数及可用比例，不以固定allow/challenge文案隐去真实处理动作；不完整时比例未知

### Requirement: Atomic notification blocks and byte budget
通知 MUST 同时满足maxLength与2000 UTF-8 bytes。所有选中Host最小状态、必要过滤/未知范围/非block/采样限定语、固定窗口与数据截至、覆盖、完整incident_id/correlation_id和至少一条Dashboard人工核验建议 MUST 预留。低优先级明细/原始上下文/额外AI建议可整块省略并标注，不留半实体/空标题。新Webhook ID各128 UTF-8 bytes上限与旧Queue兼容不变；旧超长ID/极小预算无法表达最小消息 MUST 受控通知失败并ack，不能丢ID发送或重放采集。

#### Scenario: Five long hosts with degradation
- **WHEN** 五Host、长中文emoji字段、完整ID及多个质量限定接近预算
- **THEN** 输出≤2000字节，全部Host最小状态/必要限定/窗口/完整ID保留，明细公平整块省略

#### Scenario: Unrepresentable historical identifiers
- **WHEN** 完整历史ID致最小消息仍超预算
- **THEN** notification_content_unrepresentable受控失败并ack，不发送残缺消息
