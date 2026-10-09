## MODIFIED Requirements

### Requirement: Verified query-side attention scope
系统 MUST 在发现/选择Top Host前排除严格action="block"，所有Host聚合、样本、Statistics、Findings、Evidence和事件明细 MUST 使用相同过滤范围、Host与固定窗口。未知Action MUST NOT 默认为block，不区分规则来源或核验IP黑名单；同IP/Host的非block事件 MUST 保留。两dataset的能力 MUST 以目标Schema/settings和脱敏证据核验；MUST NOT 假设action_neq保留底层null或加入未核验action:null、白名单过滤或未过滤明细回退。

发现 MUST 保留rawTotal、rawActions、attentionTotal和过滤topHosts四alias。原始Action分布未知、截断、重复或普通估计差异 MUST 只收紧静默/覆盖资格；已有有效过滤后Host MUST 继续分析并说明范围限制。过滤查询真正失败/协议无效 MUST 按失败处理，不复用该失败操作的部分data。

本Requirement显式取代上一版“Filter capability unavailable”和“Raw action distribution cannot establish attention scope”中一律在Host/AI前基础降级的规则，以及各delta末尾重复“运行时Action保留守卫”的计数相等全局门槛。block直接计数来源仍为原始精确block分组，不得相减推算；分布未截断、无重复、安全加总且无未知类别时可标为完整直接估计，不再要求与rawTotal相等；否则blockedTotalEvents为null而保留已知分组观察。

#### Scenario: Blocked hosts dominate original ranking
- **WHEN** 原热门Host全部block，其他Host存在非block
- **THEN** 过滤后排名让其他Host进入名额，block不进入任何Host明细

#### Scenario: Same entity mixed actions
- **WHEN** 同IP同Host同时出现block、allow、managed_challenge、BLOCK或未知非空字符串
- **THEN** 仅精确block被排除，不trim/lowercase归并，不整IP/Host排除

#### Scenario: Incomplete original context with usable hosts
- **WHEN** rawActions有null/缺失/空串、截断或重复，但过滤后有有效正计数Host
- **THEN** 保留可靠Host分析，必需通知提示未知范围未可靠覆盖；不可比较Zone比例为null，不假装底层null已被保留

#### Scenario: Filter operation fails
- **WHEN** 过滤不支持、关键响应无效或HTTP200含GraphQL errors
- **THEN** 该操作失败、不填零、不猜语法、不回退未过滤事件，基础异常或Host局部失败按操作范围处理

### Requirement: Trustworthy suppression decision
系统 MUST 由确定性程序而非LLM决定静默。只有响应有效、rawTotal>0、rawActions非空未截断无重复无不可判定类别且安全计数、至少一个正计数精确block且所有正计数类别仅精确block、attentionTotal有效为0、过滤Top Host原数组为空且无否定证据，才 SHALL suppressed/no_attention_events_observed。MUST 保留adaptive_aggregate与稀少事件可能遗漏的风险；采样或采样状态未知本身不得阻止静默。

不同独立查询正数计数不相等本身 MUST NOT 阻止静默；MUST NOT 要求block=rawTotal、sum(rawActions)=rawTotal或绝对完整采样覆盖证明。MUST 保留具体质量差异，不使用任意百分比容差。正非block证据、零/正语义冲突、未知Action、截断/重复分布和非空Top列表 MUST 阻止静默。协议失败、unsafe计数或和不能当作估计差异。

#### Scenario: All blocked with eligible quality
- **WHEN** 有效观察全部精确block，过滤总量0和Top空，满足静默条件
- **THEN** 不调用AI、Formatter或企微，正常ack，不宣称底层绝对无非block事件

#### Scenario: Positive estimates differ
- **WHEN** rawTotal=1360、唯一正计数block分组1362、attentionTotal=0、Top空
- **THEN** 静默，保留直接block估计1362及raw_action_sum_mismatch，不发送基础告警

#### Scenario: Zero contradicted by positive evidence
- **WHEN** attentionTotal=0但原始非block或过滤Top Host为正，或rawTotal=0但其他观察为正
- **THEN** 不静默、不判原始空；有可靠Host继续分析，否则通知已知事实与范围不足

#### Scenario: Insufficient action or ranking evidence
- **WHEN** rawTotal>0但Action空/全零、Action有未知/截断/重复，或Top仅返回零计数条目
- **THEN** 不静默；有可靠过滤Host继续，否则明确基础降级原因

### Requirement: Distinct raw empty and failed outcomes
系统 MUST 区分原始空窗口、观察零静默、有Host可继续/部分降级、无Host范围不足和查询失败。有效rawTotal=0、attentionTotal=0、Action无正计数且无未知/截断/重复、Top原数组空 SHALL 发送raw_window_empty数据不足通知。无可用Host但存在非block证据 MUST no_usable_hosts通知已知事实，不伪造Host/IP/路径/AI结论。仅原始上下文不一致 MUST NOT 导致整个告警丢失可靠过滤后Host。有限TopN没有Host不能证明整个Zone无事件。

#### Scenario: Original empty window
- **WHEN** 原始与过滤观察均为有效零且无否定证据
- **THEN** 数据不足通知，AI0，区别suppressed与collection_failed

#### Scenario: Non-block evidence without hosts
- **WHEN** 原始Action有非block正数或attentionTotal>0，但无有效正计数Host
- **THEN** 发送固定窗口、已知观察及“未取得可用Host明细”，零AI，不按raw_empty处理

#### Scenario: Original mismatch retains host data
- **WHEN** 原始总量与Action和不等但有有效过滤后Host
- **THEN** 正常采集并按Host通知，质量标记不得替换全部Host块

### Requirement: Suppression lifecycle and safe diagnostics
静默 MUST 为正常业务终态并ack，不主动Queue重放、不记录notification_sent。固定窗口、至少一次投递、Host局部AI降级、企微同文本有限重试及已发送后不重放 MUST 保持。日志失败 MUST NOT 改变静默或已发送结果。

受控脱敏判定日志 MUST 包含incident_id、correlation_id、analysis_window、policy_id、decision_version、最终静默/继续/部分降级/基础异常决策、具体reasonCodes、原始与过滤总量、Action受控分类计数、分布截断标识、未知Action计数、过滤Top Host数量/计数和、不一致比较及不可用比例、AI/企微实际调用状态。失败未知值 MUST 为null/不可用而非0；未知Action原字符串映射受控other_non_block或unknown，MUST NOT 输出Token、Webhook地址、IP/路径样本、模型原文或大型响应。

#### Scenario: Decision diagnostics
- **WHEN** rawAction和与raw不同且仍分析Host
- **THEN** 日志标明raw_action_sum_mismatch及比较值，记录实际AI/通知状态，不只记录“数据口径不一致”

#### Scenario: Terminal logger failure
- **WHEN** 静默或企微已成功后logger抛错
- **THEN** ack正常且无主动retry；静默AI0/企微0，不伪造发送成功日志

#### Scenario: Retry boundaries
- **WHEN** 企微临时错误触发有限阶段内重试
- **THEN** 每次使用相同最终文本，不重跑GraphQL/LLM；所有查询技术重试复用原窗口

### Requirement: Fixed policy compatibility
系统 MUST 保持固定过滤策略exclude-exact-block-v1，不增加env策略开关或Queue字段；判定日志使用decision_version=aggregate-quality-v2区分新判定。新Consumer MUST 对合法新旧v1消息使用相同新判定，保留原窗口、配置快照及旧消息缺hostLimit时的固定默认值。另经授权回滚到上一静默发布提交 SHALL 恢复旧整体降级行为，不能承诺跨版本策略快照、exactly-once或回补历史静默。

本Requirement全文替换旧同名Requirement及其末尾附属“运行时Action保留守卫”：发现仍为四alias、分布仍限20类，静默仍要求可判定且未截断，但跨alias计数相等 MUST NOT 作为继续Host分析或全block观察静默的前置条件。正数差异、未知/截断和零/正冲突 MUST 按本Change的Verified query-side attention scope及Trustworthy suppression decision处理；MUST NOT 保留旧“上述任一不足即Host/AI均0”的附属场景。正常1+2H HTTP、4+8H nodes预算与范围污染的局部隔离不变。

#### Scenario: Historical queue message
- **WHEN** 新Consumer收到合法旧v1消息，包括缺hostLimit的旧消息
- **THEN** 应用更新判定与既有固定过滤策略，原始窗口/配置不变，日志可识别判定版本

#### Scenario: Rollback to previous suppression release
- **WHEN** 另经授权整包回滚至4318457
- **THEN** Queue消息仍兼容，恢复上一静默版本及其全局降级缺陷，不迁移删除消息或承诺历史回补
