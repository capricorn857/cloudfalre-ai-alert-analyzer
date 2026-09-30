## Purpose

在一次固定窗口的Cloudflare告警快照中提供Zone总览和有限Host的独立采集、统计、证据验证与规则降级，并以单条有界企业微信文本呈现防护结果和集中建议，避免跨Host混算、无依据联合归因及通知裁剪丢失关键状态。

## ADDED Requirements

### Requirement: Fixed-window staged snapshot
系统 MUST 先获取固定Zone和窗口的事件总量及Top Host，再对有限Host分别查询现有维度；所有查询与技术重试 MUST 使用Queue中相同zone、start、end、query_started_at，不得移动窗口、等待数据增长或补采。

#### Scenario: Same path in different hosts
- **WHEN** example.test的/login为300事件且Host总量600，www.example.test的/login为30且总量300
- **THEN** 系统分别保存300与30，不合并成330，并分别计算50.0%与10.0%

#### Scenario: Identical retry window
- **WHEN** 任一Host查询发生临时失败或Queue技术重放
- **THEN** 每次请求的Zone与窗口字符串保持原消息值；不会因空数据或排名变化开始新业务轮次

### Requirement: Bounded host selection and configuration snapshot
`hostLimit` MUST 为1..5整数、默认3，并在producer写入配置快照。旧schemaVersion1消息缺该字段 MUST 固定默认3，不能用当前env覆盖；非法显式值 MUST 拒绝。发现Host最多10项，按事件降序、Host原值字典序决胜，选择有效正计数Host，不穷举、不补位失败Host。

#### Scenario: Config changes during delivery
- **WHEN** 消息hostLimit=2入队后运行配置改为5
- **THEN** 消费与重试最多分析原消息配置的2个Host，窗口和sampleLimit同样不变

#### Scenario: Null or truncated hosts
- **WHEN** Top列表有null/空白Host，或达到10条/有效候选超过hostLimit
- **THEN** 不查询空Host，不改成Zone名称，不合并根域/www；通知标注有限范围及未覆盖，不把数组长度当Host总数

### Requirement: Verified bounded GraphQL collection
Host MUST 包含独立总量、四维Top、Action、Source、有界样本与采集状态。查询字段、过滤、标量及套餐限制 MUST 有官方Schema/settings核验依据，不能把HTTP数据集的Host过滤假定适用于WAF。实施查询前未取得证据 MUST 保持门禁；运行时HTTP200非空errors MUST 视为该操作失败。

应用采集预算 SHALL 为1+2H正常HTTP，最多2个并发HTTP，每个临时失败至多1～2次重试，整采集阶段90秒硬截止，最大H=5时GraphQL至多33次尝试；不得无限请求或分页。样本每Host默认50、最多100；四维每维最多10，Action/Source最多20。

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

#### Scenario: Cross-host evidence
- **WHEN** h0的声明引用真实存在的h1统计/Finding/总量或样本
- **THEN** 拒绝h0完整AI结果并记录受控host_mismatch，h1合法结果不受影响

#### Scenario: Wrong denominator
- **WHEN** Host统计使用Zone总量或另一Host总量，或UA使用总样本数而不是非空UA数
- **THEN** 来源一致性验证拒绝该目录，不允许LLM或Formatter使用错误百分比

#### Scenario: Independent ranks cannot prove a relationship
- **WHEN** 同Host Top ASN与Top Path分别存在，但没有联合统计
- **THEN** 不生成“该ASN访问该路径”的总体结论；新增联合关系输出字段被拒绝，单条样本仅能描述其一条事件

### Requirement: One bounded multi-host AI request
系统 MUST 使用一个逻辑LLM请求、schema_version3封闭多Host输出；每Host observations最多3、recommendations1..2、每节点引用最多4。MUST 不新增SDK、修复prompt或每Host独立LLM请求。输入messages至多64KiB、请求body至多96KiB；响应至多128KiB、content至多32KiB；输出token沿用512..8192、默认2048，HTTP429/5xx最多一次内部重试，共享已有总超时。

#### Scenario: One invalid host result
- **WHEN** 根结构有效且host_id唯一已知，但h0内容结构/引用/支持失败，h1合法
- **THEN** h0规则降级，h1保留验证结果，不重新计算统计或请求模型；缺少某预期Host项亦只降级该Host

#### Scenario: Invalid envelope
- **WHEN** 非JSON、截断、拒绝、根额外字段/版本错误、重复/未知/不可定位host_id或hosts数组非法
- **THEN** 所有请求Host的AI降级，保留采集成功的程序事实，原文不得进入通知/日志

### Requirement: Unchanged controlled conclusions
风险 SHALL 是程序计算的规则关注等级，集合限IP/Path/Country/ASN/allow/rate，按完整集合最高级决定，资格不足Unknown。AI MUST 保留原精确引用角色与支持门槛，不支持CRITICAL或除Bot以外具体攻击；Unknown允许保守弃权且attack置信度0/空引用。

Bot MUST 由同Host至少10个非空UA样本、UA与速率两个high Finding及统计、riskAssessable支持，自评置信度>0且<=0.6。模型输出 MUST 不含自由文本事实、实体、统计数字或可执行配置。AI降级 MUST 不抹除有效的程序规则等级。

#### Scenario: Bot threshold retained
- **WHEN** Host只有9个非空UA样本，即使另一Host有足够样本且两个Finding为high
- **THEN** 不支持该Host的Bot；不得拼接跨Host样本或放宽阈值，攻击判断为Unknown或该HostAI降级

#### Scenario: Unsupported attack or cherry-picked risk
- **WHEN** 模型仅凭/login返回Brute Force，或在同Host存在high Finding时选择medium
- **THEN** 支持校验拒绝该Host，不把实体存在视为攻击证明或隐藏最高规则关注等级

### Requirement: Mobile-readable single notification
通知 MUST 为单条text，顺序为Zone概览、Host防护/来源目标、集中处理建议、时间覆盖追踪。Host按显示顺序加“一：”至“五：”编号；规则关注等级仅用于内部计算和排序，不在通知展示。标签 MUST 统一中文，比例一位小数；每个维度标签独占一行、完整明细在后续行，同类明细归组；IP/Path默认最多Top3，Country/ASN默认Top1。所有选中Host MUST 保留结果或失败标记，排序为HIGH/MEDIUM/Unknown/LOW、同级发现计数降序/Host字典序。MUST 不出现重复摘要与Evidence或建议和Top列表交错。

#### Scenario: Numbered Host sections and Dashboard link
- **WHEN** 渲染多个Host的通知
- **THEN** 显示中文Host序号、标签换行及成组明细，省略规则关注文案；集中建议包含有效HTTPS dash.cloudflare.com告警链接，缺失、不安全或超过300字符时回退官方Dashboard首页；不伪造账户或Zone专属链接

#### Scenario: AI recommendation attribution
- **WHEN** 通知包含通过支持校验的模型建议
- **THEN** 这些建议以独立“AI 分析处理建议”标题展示并保留Host归属，标题和正文整块保留或省略；固定Dashboard提示置于“人工核验处理建议”，整体AI不可用时改为“规则分析处理建议”；没有可展示的已校验AI建议时不得出现AI建议空标题

#### Scenario: Protection outcome
- **WHEN** Host完整Action且block计数精确等于正Host总量
- **THEN** 可说“本 Host 快照事件全部标记为 block”，不得说“全部攻击已阻止”；四舍五入100.0%不足以支持“全部”

#### Scenario: Undetermined attack type omitted
- **WHEN** Host攻击类型为Unknown或AI不可用
- **THEN** 通知省略攻击类型字段及“攻击类型未确定”占位，仍保留AI降级或采集失败状态及必要限定语；已校验Bot判断继续携带人工核验与非攻击概率限定语

#### Scenario: Host section ordering
- **WHEN** 存在高关注Host、失败Host和低关注Host
- **THEN** 按规定内部等级排序，每Host段先序号和防护，所有建议集中放在Host段之后且保留归属

### Requirement: Atomic notification blocks and byte budget
通知 MUST 不超过2000 UTF-8 bytes及既有maxLength；标题与正文、结论与必要限定语 MUST 一同保留或省略。MUST 预留所有Host最小状态块、至少一条含Dashboard链接的人工核验建议、固定时间窗口/数据截至/时区、覆盖、完整incident_id/correlation_id；可舍弃低优先级明细、额外观察、Payload参考数，明确省略，不留空标题/半实体。覆盖不附加重复的“仅分析所选Host”，Top Host截断或口径不一致时仍明确说明；保留排名独立和采样限定。

新Webhook两种ID MUST 各限128 UTF-8 bytes，超限400且不入队。旧Queue仍可解析；历史ID或极小maxLength致最小消息不可表示 MUST 受控通知失败并ack，不发送空串或丢ID的替代消息。

#### Scenario: Long multilingual message
- **WHEN** 五Host、长中文/emoji路径与多个Top项接近或超过2000字节
- **THEN** 按完整区块及公平份额省略明细，保留各Host状态、限定语、窗口与ID；输出不超过2000字节，无空标题或半条结论

#### Scenario: New oversized trace identifier
- **WHEN** 新告警关联ID超过128 UTF-8 bytes
- **THEN** 返回400，不截断标识、不入队；128 bytes合法值继续原有验证及入队流程

#### Scenario: Unrepresentable historical message
- **WHEN** 旧消息完整ID使最低通知仍超限
- **THEN** 不发送缺ID通知，记录notification_content_unrepresentable并ack，不触发GraphQL/LLM重放

### Requirement: Failure isolation and atomic migration
系统 MUST 保留Queue至少一次投递；LLM失败局部或整体降级，WeCom仅阶段内有限重试同一文本，耗尽后ack，发送成功后不得主动抛错触发Queue重放。Catalog/Prompt/AI Schema/支持验证/Formatter MUST 同版本切换及整包回滚，旧AI输出拒绝，不双跑旧自由文本契约。日志 MUST 使用受控Host ID/状态/计数与现有关联字段，不包含凭证、实体、模型原文或原始响应。

#### Scenario: Notification retries
- **WHEN** 企微临时失败重试或发送后日志抛错
- **THEN** 仅重试已生成同一文本或保持发送成功并ack，不重采集、重算统计或调用LLM

#### Scenario: Old and new queue compatibility
- **WHEN** 新Consumer收到旧v1消息，或旧Consumer收到带hostLimit的新v1消息
- **THEN** 前者固定默认3，后者忽略新增字段恢复Zone分析，二者保留原窗口/ID；回滚文档明确Host功能退化与潜在重复通知

#### Scenario: Safe host diagnostics
- **WHEN** 外部错误/模型非法Host键或字段含敏感哨兵
- **THEN** 仅记录受控阶段、原因、h0等程序ID和计数，哨兵/原文不进入日志或通知
