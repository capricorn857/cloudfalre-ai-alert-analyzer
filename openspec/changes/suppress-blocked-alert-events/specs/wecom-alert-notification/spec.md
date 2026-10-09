## MODIFIED Requirements

### Requirement: Required notification content
非静默正常快照通知 SHALL 展示域名、告警时间、分析窗口及数据截至时间、待关注 GraphQL 事件总量、必要降级状态、过滤后选中Host状态、Dashboard Link、`incident_id` 和 `correlation_id`。Top IP/Country/ASN/Path、待关注Action、已校验观察和建议按host-scoped字节预算展示；不得重复摘要与Evidence，内部关注等级不展示，Payload参考数及原始上下文可按预算省略。

符合Adaptive观察门槛的no_attention_events_observed静默结果 MUST 跳过Formatter和企微，不要求生成通知；observationBasis为adaptive_aggregate并保留采样风险说明，采样或采样状态未知本身不触发基础通知。非静默通知 MUST 明确显示过滤后的待关注事件，比例和Host明细共用过滤范围；原始Zone计数若展示仅作带质量标识的上下文。按已确认host-scoped契约，风险等级仅用于内部排序，所有过滤后选中Host在预算内保留状态，必要限定语/固定窗口/完整ID不可省略。非block MUST NOT 被表述为攻击成功或已到源站。

#### Scenario: Complete snapshot notification
- **WHEN** 快照数据和 AI 分析均可用
- **THEN** 非静默通知包含多Host展示契约规定的必需字段，比例基于相应过滤后 GraphQL `total_events`

#### Scenario: Payload and GraphQL counts differ
- **WHEN** Payload 事件数与 GraphQL `total_events` 不同
- **THEN** 通知区分参考告警数和快照统计数，不暗示两者必须相等

#### Scenario: Timezone presentation
- **WHEN** Formatter 展示告警时间或分析窗口
- **THEN** 通知使用配置的展示时区并明确标识时区，内部 UTC 值的含义不改变

### Requirement: Empty and collection-failure messages
有效原始数据为空或 Cloudflare 数据采集最终失败时，系统 SHALL 发送不包含虚构统计和 AI 结论的基础通知。

空数据仅指有效原始窗口零数据；过滤后零 MUST 按blocked-event-suppression质量门槛判断，不能复用原始空文案。符合观察静默门槛不通知；过滤失败、计数不一致或关键数据不完整 SHALL 发送明确原因的基础降级通知，不包含未过滤block明细或虚构AI结论。

#### Scenario: Empty snapshot data
- **WHEN** 固定窗口内有效原始总量、待关注总量及原始Action分布中的block计数均零且排名为空
- **THEN** 通知明确说明当前分析窗口未查询到足够 Security Events 数据并展示固定窗口

#### Scenario: Cloudflare collection fails
- **WHEN** Cloudflare API 有限重试后仍失败
- **THEN** 通知展示告警基本信息、窗口和数据采集失败状态，不展示伪造的 Top 列表或 AI 判断

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
