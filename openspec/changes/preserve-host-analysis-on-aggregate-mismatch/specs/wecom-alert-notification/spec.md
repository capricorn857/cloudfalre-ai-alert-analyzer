## MODIFIED Requirements

### Requirement: Required notification content
非静默通知 SHALL 展示Zone、过滤后待关注快照计数及“已排除action=block”、所有选中Host结果/失败状态、必要质量限定、固定窗口/告警时间/数据截至与时区、覆盖、Dashboard建议、完整incident_id/correlation_id。Host明细和真实Action分布按多Host契约与2000 UTF-8 bytes预算展示；原始上下文若展示 MUST 明确标注，不作Host攻击结论或比例分母。

原始正数计数不一致、未知/截断分布 MUST NOT 独自触发所有Host被基础告警替换。零Zone正Host MUST 展示冲突与Host明细、Zone占比和覆盖未知，不能说整个窗口零事件。非block MUST NOT 被解释为攻击成功/绕过防护/到源站。AI建议仅由已校验结构化输出与合法Evidence渲染，不直接发送模型原文；原始block明细及据其生成的核验IP建议禁止。

#### Scenario: Preserve original multi-host structure
- **WHEN** 过滤Host可用而原始聚合不一致
- **THEN** 保留编号Host、计数、Action、可用维度和局部降级说明，不整体改成无Host基础告警

#### Scenario: Suppressed snapshot
- **WHEN** 满足更新后的确定性观察静默条件，即使原始正数估计不同
- **THEN** 完全跳过Formatter与企微，不生成占位通知

### Requirement: Empty and collection-failure messages
系统 SHALL 区分raw_window_empty数据不足、no_usable_hosts范围不足、未知/不完整但无可用Host的基础降级与真正collection_failed基础异常。仅有效原始窗口全部观察为零且无否定证据才能用原始空文案。非block证据但Host空 SHALL 展示明确来源的已知事实、窗口与“未取得可用Host明细”，不虚构实体或AI结论、不由TopN推断Zone无事件。真实关键查询失败不能使用该失败操作部分data或用零替代。部分可靠Host存在时 SHALL 走多Host部分降级通知，显式替换上一版“计数不一致一律基础通知”的要求。

#### Scenario: Raw empty versus no hosts
- **WHEN** 原始非block正但过滤Top空
- **THEN** 显示范围不足及原始观察来源，不显示原始空窗口、不伪造过滤后计数或AI结论

#### Scenario: Collection failure
- **WHEN** 发现查询有限重试耗尽、关键响应缺失或带errors
- **THEN** 基础异常通知展示具体失败类别、固定窗口和ID，不伪造零/Host明细

#### Scenario: Genuine raw empty
- **WHEN** 原始与过滤观察均有效零、分布无未知/截断/重复、排名为空
- **THEN** 发送数据不足通知，区别静默结果，不调用AI

