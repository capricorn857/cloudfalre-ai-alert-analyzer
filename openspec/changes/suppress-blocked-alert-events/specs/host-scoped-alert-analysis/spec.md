## MODIFIED Requirements

### Requirement: Fixed-window staged snapshot
系统 MUST 先获取固定Zone和窗口的待关注事件总量及过滤后Top Host，再对有限Host分别查询现有维度；所有查询与技术重试 MUST 使用Queue中相同zone、start、end、query_started_at，不得移动窗口、等待数据增长或补采。

系统 MUST 在发现及选择Top Host前排除严格action=block，先获得同窗口原始总量、待关注总量及直接block计数，再按待关注排名选择Host。满足blocked-event-suppression质量门槛时 MUST 正常静默，不采集Host或调用AI/企微；不能以所选Host代替全Zone判定。静默reason为no_attention_events_observed、observationBasis为adaptive_aggregate并标注采样风险；采样或采样状态未知本身不阻止满足完整协议及内部一致性门槛的静默。以下Host数值均指待关注范围。

#### Scenario: Same path in different hosts
- **WHEN** example.test的/login为300事件且Host总量600，www.example.test的/login为30且总量300
- **THEN** 系统分别保存300与30，不合并成330，并分别计算50.0%与10.0%

#### Scenario: Identical retry window
- **WHEN** 任一Host查询发生临时失败或Queue技术重放
- **THEN** 每次请求的Zone与窗口字符串保持原消息值；不会因空数据或排名变化开始新业务轮次

### Requirement: Bounded host selection and configuration snapshot
`hostLimit` MUST 为1..5整数、默认3，并在producer写入配置快照。旧schemaVersion1消息缺该字段 MUST 固定默认3，不能用当前env覆盖；非法显式值 MUST 拒绝。发现Host最多10项，按事件降序、Host原值字典序决胜，选择有效正计数Host，不穷举、不补位失败Host。

Top10及hostLimit MUST 应用于排除block后的待关注范围；未过滤的热门Host不得占名额。Action未知/缺失不得通过已知Action白名单被排除。待关注总量为正但无有效Host MUST 提示未覆盖并通知，不得静默。

#### Scenario: Config changes during delivery
- **WHEN** 消息hostLimit=2入队后运行配置改为5
- **THEN** 消费与重试最多分析原消息配置的2个Host，窗口和sampleLimit同样不变

#### Scenario: Null or truncated hosts
- **WHEN** Top列表有null/空白Host，或达到10条/有效候选超过hostLimit
- **THEN** 不查询空Host，不改成Zone名称，不合并根域/www；通知标注有限范围及未覆盖，不把数组长度当Host总数

### Requirement: Verified bounded GraphQL collection
Host MUST 包含独立总量、四维Top、Action、Source、有界样本与采集状态。查询字段、过滤、标量及套餐限制 MUST 有官方Schema/settings核验依据，不能把HTTP数据集的Host过滤假定适用于WAF。实施查询前未取得证据 MUST 保持门禁；运行时HTTP200非空errors MUST 视为该操作失败。

应用采集预算 SHALL 为1+2H正常HTTP，最多2个并发HTTP，每个临时失败至多1～2次重试，整采集阶段90秒硬截止，最大H=5时GraphQL至多33次尝试；不得无限请求或分页。样本每Host默认50、最多100；四维每维最多10，Action/Source最多20。

发现阶段 SHALL 使用4个逻辑alias（raw总量、attention总量、原始Action分布中的block计数、attention Top Host），Host聚合7 alias及样本1 node全部同一待关注谓词。正常HTTP仍1+2H，node selections为4+8H，H=5时44，最多2次技术重试时132；质量字段计入字段预算。MUST 核验两dataset的Action精确否定/字段及新alias/目标Zone预算证据，以运行时rawActions守卫和对抗测试覆盖未知空值、有效零与观察一致性；底层null保留未证实不得声称已验证，不得借Host既有核验视作通过。预算不能因零结果扩张。

#### Scenario: Unverified schema
- **WHEN** 无认证introspection拒绝且没有目标字段的官方脱敏导出
- **THEN** 候选Host filter不被标记为已验证，不开始依赖该假设的查询实现，不读取未经授权的真实Secret

#### Scenario: Partial GraphQL data with errors
- **WHEN** Host聚合响应包含部分data和非空errors
- **THEN** 整个该Host聚合操作失败，不把缺alias当零；其他成功Host保留

#### Scenario: Budget exhausted
- **WHEN** 并发Host请求未在90秒采集截止内完成
- **THEN** 取消在途请求并标记未完成项预算耗尽，保留已完成结果，不继续后台采集或重放整条消息

### Requirement: Host-owned statistics and quality
系统 MUST 独立计算每Host的Statistics、Findings和规则关注等级。Host四维与Action/Source比例分母 MUST 为hostTotalEvents；占Zone比例分母 MUST 为zoneTotalEvents；UA集中度 MUST 以该Host全部已采集有界样本中非空UA数为分母；平均事件速率 MUST 为Host总量/固定窗口秒数。Payload events_count MUST 仅参考。

计数不一致、零分母或截断导致不可用比例 MUST 表示null并说明原因，不得补齐、clamp、换分母或推算Host总量。Action/Source完整性 MUST 同时满足未触及limit且sum=Host总量，才能作完整分布判断。

这里hostTotalEvents、zoneTotalEvents及所有维度/样本 MUST 为待关注范围，zoneTotalEvents等于attentionTotalEvents；原始rawTotalEvents只作明确标注上下文。Action分类 MUST 保持精确值语义，BLOCK不得计为block。UA分母只包含待关注样本中非空UA；速率仍使用原窗口。未知Action不是已拦截，必要数据不完整继续Unknown/局部降级。

#### Scenario: Different sources and actions
- **WHEN** 两Host有不同IP/ASN/Action且Zone总量1000
- **THEN** 每个Host只使用自己的来源、处理计数与Host分母，不能借另一Host或Zone的分布生成Finding

#### Scenario: UA and event-rate denominators
- **WHEN** Host总量600、窗口1860秒、10个非空UA样本中某UA出现6次，而传给AI仅5条样本
- **THEN** UA集中度为60.0%，平均速率为600/1860，裁剪AI样本不改变任一分母

#### Scenario: Invalid or incomplete aggregates
- **WHEN** 某维count或sum超过Host总量，或Action/Source截断或和不等于总量
- **THEN** 对应比例不可用并带质量状态；不补出缺失计数、不推断全部阻止、不以分类和重新归一

#### Scenario: Zero events
- **WHEN** Zone有效零且列表为空，或选中Host查询有效零且聚合/样本为空
- **THEN** 明确零事件与数据不足，不调用该范围LLM，不输出NaN/无限值/虚构百分比；若零总量伴随正计数则标为不一致

### Requirement: Honest coverage and isolated collection failures
通知 MUST 展示实际已分析Host数、失败数及可信事件覆盖，不得编造总Host数。完整聚合成功但样本失败 SHALL 计入已分析和可信覆盖，并明确样本失败；聚合失败 MUST 不计为成功，不伪造零。Host总量与发现计数不一致或成功总和超过Zone总量 MUST 使覆盖比例不可用，不强行归一。

覆盖及zoneShare MUST 使用待关注总量；原始Zone上下文不得混入覆盖分母。raw/attention/block独立采样查询不可简单相减，比较不可靠时明确未知或不可比较；计数相等不证明完整采样。只统计已成功分析的过滤后Host，失败/空Host或TopN不得触发全局静默。

#### Scenario: Top host coverage
- **WHEN** Zone总量1000、已成功分析Host600与300，另有未分析事件
- **THEN** 显示已分析2个Host、覆盖估计90.0%及所选范围限定；不显示2/未知总数

#### Scenario: One host failed
- **WHEN** 第二个Host聚合失败而第一个Host600事件成功
- **THEN** 保留第一个结果，第二个标为失败/总量未知，显示已分析1、失败1、覆盖估计60.0%；不将发现的300当成功分析量

#### Scenario: Discovery and host counts differ
- **WHEN** 发现阶段某Host为600而后续同窗口Host总量为610
- **THEN** 保留来源区分，Host内部一致统计可用，占Zone及整体覆盖不可比较且说明聚合差异，不发第二轮查询

### Requirement: Host-owned bounded evidence
Catalog MUST 升级version2，显式区分Zone与Host归属以及context/aggregate/sample口径；聚合、统计、Finding和样本 MUST 携带可验证归属，比例/速率 MUST 可校验分母及窗口。相同输入版本 MUST 生成稳定局部ID，裁剪不得改实体或重算原统计。

Catalog SHALL 每Host最多64项/10KiB，Zone最多8项、全体328项/56KiB，业务字符串2048bytes；按完整依赖闭包裁剪。必需Host上下文无法容纳 MUST 仅该Host目录失败；根目录不可用 MUST 整体AI降级。

Catalog MUST 携带固定policyId=exclude-exact-block-v1与eventScope=attention，来源验证与Formatter重建使用同一标记。Host全部Evidence只能来自过滤后事实；raw及直接block上下文不得成为攻击证据，block明细不得生成review_source建议。缺scope旧目录拒绝，不放宽已有归属/分母/支持门槛；AI wire仍v3、Catalog仍v2且同包迁移。非block不证明攻击成功或到达源站。

#### Scenario: Cross-host evidence
- **WHEN** h0的声明引用真实存在的h1统计/Finding/总量或样本
- **THEN** 拒绝h0完整AI结果并记录受控host_mismatch，h1合法结果不受影响

#### Scenario: Wrong denominator
- **WHEN** Host统计使用Zone总量或另一Host总量，或UA使用总样本数而不是非空UA数
- **THEN** 来源一致性验证拒绝该目录，不允许LLM或Formatter使用错误百分比

#### Scenario: Independent ranks cannot prove a relationship
- **WHEN** 同Host Top ASN与Top Path分别存在，但没有联合统计
- **THEN** 不生成“该ASN访问该路径”的总体结论；新增联合关系输出字段被拒绝，单条样本仅能描述其一条事件

### Requirement: Mobile-readable single notification
通知 MUST 为单条text，顺序为Zone概览、Host防护/来源目标、集中处理建议、时间覆盖追踪。Host按显示顺序加“一：”至“五：”编号；规则关注等级仅用于内部计算和排序，不在通知展示。标签 MUST 统一中文，比例一位小数；每个维度标签独占一行、完整明细在后续行，同类明细归组；IP/Path默认最多Top3，Country/ASN默认Top1。非静默通知中的所有过滤后选中Host MUST 保留结果或失败标记，排序为HIGH/MEDIUM/Unknown/LOW、同级发现计数降序/Host字典序。MUST 不出现重复摘要与Evidence或建议和Top列表交错。

本通知契约仅适用于未静默结果；符合可信no_attention_events_observed时 MUST 完全跳过通知。通知 MUST 明示“待关注事件（已排除 action=block）”，Action区为待关注处理分布，不能把block=0解释为防护失败。非block不证明攻击成功或到达源站的限定语 MUST 保留；raw上下文若展示需独立标识。过滤失败只能基础降级，不能发送未过滤明细。

#### Scenario: Numbered Host sections and Dashboard link
- **WHEN** 渲染多个Host的通知
- **THEN** 显示中文Host序号、标签换行及成组明细，省略规则关注文案；集中建议包含有效HTTPS dash.cloudflare.com告警链接，缺失、不安全或超过300字符时回退官方Dashboard首页；不伪造账户或Zone专属链接

#### Scenario: AI recommendation attribution
- **WHEN** 通知包含通过支持校验的模型建议
- **THEN** 这些建议以独立“AI 分析处理建议”标题展示并保留Host归属，标题和正文整块保留或省略；固定Dashboard提示置于“人工核验处理建议”，整体AI不可用时改为“规则分析处理建议”；没有可展示的已校验AI建议时不得出现AI建议空标题

#### Scenario: Protection outcome
- **WHEN** 查询已排除block并生成待关注Host通知
- **THEN** 不展示被过滤Host的block防护明细，不将待关注非block解释为攻击成功；全Zone只有满足可信静默门槛才不发通知，显示100.0%不足以支持静默

#### Scenario: Undetermined attack type omitted
- **WHEN** Host攻击类型为Unknown或AI不可用
- **THEN** 通知省略攻击类型字段及“攻击类型未确定”占位，仍保留AI降级或采集失败状态及必要限定语；已校验Bot判断继续携带人工核验与非攻击概率限定语

#### Scenario: Host section ordering
- **WHEN** 存在高关注Host、失败Host和低关注Host
- **THEN** 按规定内部等级排序，每Host段先序号和防护，所有建议集中放在Host段之后且保留归属

### Requirement: Atomic notification blocks and byte budget
通知 MUST 不超过2000 UTF-8 bytes及既有maxLength；标题与正文、结论与必要限定语 MUST 一同保留或省略。MUST 预留所有过滤后选中Host最小状态块、至少一条含Dashboard链接的人工核验建议、固定时间窗口/数据截至/时区、覆盖、完整incident_id/correlation_id；可舍弃低优先级明细、额外观察、Payload参考数，明确省略，不留空标题/半实体。覆盖不附加重复的“仅分析所选Host”，Top Host截断或口径不一致时仍明确说明；保留排名独立和采样限定。

新Webhook两种ID MUST 各限128 UTF-8 bytes，超限400且不入队。旧Queue仍可解析；历史ID或极小maxLength致最小消息不可表示 MUST 受控通知失败并ack，不发送空串或丢ID的替代消息。

本预算仅适用于非静默通知。MUST 为过滤范围及非block含义限定语预留必需字节；静默结果不生成占位通知。基本异常/质量不足通知保留窗口、关联ID和稳定原因，不虚构Host明细；原始上下文计数可整体省略。

#### Scenario: Long multilingual message
- **WHEN** 五Host、长中文/emoji路径与多个Top项接近或超过2000字节
- **THEN** 按完整区块及公平份额省略明细，保留各Host状态、限定语、窗口与ID；输出不超过2000字节，无空标题或半条结论

#### Scenario: New oversized trace identifier
- **WHEN** 新告警关联ID超过128 UTF-8 bytes
- **THEN** 返回400，不截断标识、不入队；128 bytes合法值继续原有验证及入队流程

#### Scenario: Unrepresentable historical message
- **WHEN** 旧消息完整ID使最低通知仍超限
- **THEN** 不发送缺ID通知，记录notification_content_unrepresentable并ack，不触发GraphQL/LLM重放

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
