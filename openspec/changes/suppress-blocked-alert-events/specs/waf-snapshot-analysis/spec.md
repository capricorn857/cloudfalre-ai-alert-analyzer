## MODIFIED Requirements

### Requirement: Cloudflare GraphQL result contract
系统 MUST 查询并校验本次快照的 `total_events`、Top IP、Top Path、Top Host、Top Country、Top ASN、Action、Source 和受限样本。默认样本上限 SHALL 为 `50`，样本 SHALL 仅保留 `datetime`、`action`、`clientIP`、`clientCountryName`、`clientAsn`、`clientRequestHTTPHost`、`clientRequestPath`、`source` 和 `userAgent` 等允许字段。

total_events、Top维度、Action/Source和样本 MUST 统一为排除精确block后的待关注范围，且过滤先于Top Host发现；另保留rawTotalEvents及可直接可靠取得的blockedTotalEvents作为带质量标识的上下文。样本Action不可判定 MUST 不被默认block；协议不合法走降级。原始total缺失或响应无效不能用零填补。

#### Scenario: Successful GraphQL response
- **WHEN** Cloudflare 返回 HTTP 成功、无 GraphQL `errors` 且响应符合 Schema
- **THEN** 系统接受聚合和不超过 `sample_limit` 的样本数据

#### Scenario: HTTP 200 with GraphQL errors
- **WHEN** Cloudflare 返回 HTTP `200` 但响应包含 GraphQL `errors`
- **THEN** 系统将调用视为失败且不把部分原始响应作为成功数据

#### Scenario: Invalid GraphQL shape
- **WHEN** Cloudflare 响应不符合预期 Schema
- **THEN** 系统将调用视为不可用数据且不把未校验响应传入领域分析

### Requirement: Incident normalization
系统 MUST 将经过校验的 GraphQL 数据转换为 `Incident`，并 MUST NOT 向后续模块传递 Cloudflare 原始响应。`Incident` SHALL 包含 `incident_id`、Provider、告警类型、资源、告警时间、固定窗口、Payload 事件数参考值、GraphQL 指标、Evidence、受限样本和确定性 Findings 的承载位置。

本契约适用于非静默分析；可信静默 MUST 返回独立结果，不伪造空Incident。内部 MUST 区分rawTotalEvents、attentionTotalEvents、blockedTotalEvents及countQuality/comparisonStatus，并显式标记policyId与eventScope；静默结果携带reason=no_attention_events_observed、observationBasis=adaptive_aggregate及采样风险说明，采样或采样状态未知本身不阻止有效一致的全Zone观察零静默。原始上下文不流入可引用的攻击Evidence，直接block数不可用为null，不做独立采样差值。

#### Scenario: Normalize successful snapshot
- **WHEN** GraphQL 数据通过校验
- **THEN** 非静默分析生成字段命名统一、时间为 UTC 且不含 Credential 的 `Incident`

#### Scenario: Preserve event count distinction
- **WHEN** Payload `events_count` 与 GraphQL `total_events` 不同
- **THEN** `Incident` 同时保留两者并将 GraphQL `total_events` 标识为比例统计分母

### Requirement: Deterministic statistics
系统 MUST 由程序基于 GraphQL `total_events` 计算 `Statistics`，至少包含事件总量、Top IP/Path/Country/ASN 集中度、`allow_ratio`、`block_ratio` 和 `challenge_ratio`。LLM MUST NOT 参与这些计算。

所有total_events及Count MUST 属于同一Host待关注范围；Host占Zone及覆盖的分母为attentionTotalEvents。UA分母为过滤后该Host非空UA样本数，速率分母为固定窗口秒数。原始rawTotalEvents/Payload不作为待关注比例分母；无法比较时比例null。MUST 使用Action精确语义，不将大小写变体自动计入block。零统计不能单独决定静默。

#### Scenario: Calculate ratios
- **WHEN** `total_events` 大于零
- **THEN** 各集中度和 Action 比例使用对应 Count 除以 `total_events` 计算并按统一精度展示

#### Scenario: Zero total events
- **WHEN** `total_events` 为零
- **THEN** 系统产生显式的数据不足统计，不输出 `NaN`、无穷值或虚构的百分比

#### Scenario: Aggregate does not equal total
- **WHEN** 某一维度的聚合计数之和因采样或分类口径与 `total_events` 不同
- **THEN** 系统不擅自补齐计数或换分母；满足既有完整性条件的比例使用同范围 `total_events`，不满足条件的比例为null并说明质量原因

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
