# 设计说明：按 Host 独立分析与企微通知优化

## Context

实施核验更新：官方Schema与目标Zone settings已通过认证只读核验，所需字段均可用。用户另行授权一次互斥Host空结果探测，7个聚合alias在同一请求中被接受（HTTP200、无errors、全部空数组）。任务1门禁已满足，原文中“尚未核验”的描述保留为规划历史；当前依据为 `test/fixtures/graphql/host-schema-contract.json` 与verification.md。后续实施只运行离线Mock，不把探测成功解释为真实负载性能保证。

见 proposal.md 的问题与范围。源码核对基线 `ce86425`：`collectSnapshot` 的聚合查询有 total 加七维 alias，另一次 samples 请求；`Incident`、`Statistics`、`Finding` 均未携带 Host 归属；`calculateStatistics` 使用 Incident.totalEvents；`buildEvidenceCatalog` 为单目录固定 ID；`validateAIAnalysisEvidence` 有精确角色、最高风险及 Bot 门槛；`formatWeComMessage` 的 mustKeep/optional 排序导致建议与额外 Top 混排，aiBlocks 同时输出 summary 和相同 observations。

已有 `requestTimeoutMs` 100..30000、`retryCount` 1..2、独立 `llmTimeoutMs` 1000..120000（默认 30000）、`llmMaxOutputTokens` 512..8192（默认 2048）；保留这些配置边界。样本上限现为 1..100，默认 50。当前 `FormatterOptions.maxLength=3500`，另有硬上限 2000 UTF-8 bytes。本次不把现有单环境改成双环境。

## Goals / Non-Goals

仅对现有维度建立 Host 归属；各 Host 共享窗口但不是数据库事务快照。规则与模板复用适合的纯函数，不构建通用分析框架；不用 Zone 级样本拆分来替代 Host 聚合，不把 IP/ASN 与 Path 两份独立排名连接。

### 实施结构与审查修正

实际实现使用 `domain/host-analysis.ts`、`analysis/host-analysis.ts` 收敛Host契约与纯函数，`domain/host-evidence.ts`、`analysis/host-evidence.ts` 负责v2命名空间与来源校验，`notification/host-formatter.ts`、`templates.ts`、`blocks.ts` 分别负责布局、受控模板和预算。原入口名保留为同一实现的导出别名，没有第二套Zone运行链。单Host纯函数仍使用内部策略视图复用已测试的支持规则；它不是对外Catalog/AI兼容入口，LLM Client只接受Catalog v2并生成AI v3请求。

审查修正：Finding.statId必须先验证同Host、存在性和统计值，才可转换到内部策略视图；Action比例与平均速率的denominator元数据带程序原始numerator，并校验公式。样本的原始HTTP Host必须与目录context一致。可选证据在旧内部128KiB门槛之前即可整项压缩，再按每Host10KiB限额保留统计/Finding闭包和各维首项。

通知保留完整ID。遇到控制字符导致转义膨胀时，选择更短的无损、显式标签表示 `[utf8-base64:...]`；孤立代理项使用 `[utf16le-base64:...]`。普通ID不变，编码不改变Queue中的标识。预算不足时可整体省略攻击假设及其限定语、Host明细或名称，最小块仍保留规则关注、防护及每种失败/降级状态，并在该Host内标注“明细已省略”。不可表示历史消息作为本地formatter失败记录，不误归为企微API失败。

## 总体方案

### Decisions：方案比较

| 方案 | 收益 | 代价与选择 |
| --- | --- | --- |
| A：Zone 发现后逐 Host 过滤聚合和样本 | 查询预算可预测，分母和失败归属清楚 | 增加 HTTP；推荐，默认 H=3 |
| B：Zone 查询 Host+每维联合分组后本地拆分 | 可能减少 HTTP | 全局 limit 会截断每 Host 的排名，需分页补齐且组数膨胀；不采用 |
| C：只把 Zone 样本按 Host 分组 | 请求少 | 样本不是总体，无法提供所需 Host 事件分母；不采用 |

```text
Queue Message（固定 zone/window/hostLimit/sampleLimit）
  -> discoverZone（Zone 总量 + Top Host）
  -> 选 H 个 Host（不补采、不重新选失败 Host）
  -> collectHostSnapshot（同一窗口，最多两个 HTTP 同时进行）
  -> 每 Host 标准化、Statistics、Findings、规则关注等级
  -> Catalog v2（Zone namespace + Host namespaces）
  -> 一个逻辑 LLM 请求 / 每 Host 支持验证或降级
  -> 单条完整区块通知 -> WeCom 阶段内重试 -> ack
```

### 官方 Schema 与限额核验（2026-09-24）

规划阶段仅访问公开资料及一次无认证 introspection，返回9106。用户随后明确授权只读凭据使用，认证introspection已返回HTTP200并确认WAF两种Host过滤字段、聚合维度、样本字段、排序和dataset参数类型；结果见 `test/fixtures/graphql/host-schema-contract.json`。limit为uint64!、Host/zoneTag为string，filter类型分别为ZoneFirewallEventsAdaptiveGroupsFilter_InputObject和ZoneFirewallEventsAdaptiveFilter_InputObject。目标Zone settings及7alias预算尚未核验。以下表保留规划时的官方依据；字段可用性以后续认证结果为准，Mock通过不等于目标Zone套餐兼容。

| 核对项 | 官方依据与结论 |
| --- | --- |
| 样本 Host 字段 | [Querying basics](https://developers.cloudflare.com/analytics/graphql-api/getting-started/querying-basics/) 明确展示 `firewallEventsAdaptive.clientRequestHTTPHost`，变量 zoneTag 使用小写 `string` |
| 聚合与多维能力 | [Datasets](https://developers.cloudflare.com/analytics/graphql-api/features/data-sets/)：Groups 用所选 dimensions 分组。可表达多维分组不代表全球 Top-N 包含各 Host 完整 Top-N；本设计不采用交叉归因 |
| 过滤机制 | [Filtering](https://developers.cloudflare.com/analytics/graphql-api/features/filtering/) 确认 dataset filter 与等值/范围过滤；[Host 教程](https://developers.cloudflare.com/analytics/graphql-api/tutorials/end-customer-analytics/) 的 `clientRequestHTTPHost` 过滤示例属于 HTTP 数据集，不能据此证明 WAF 两个 input type 的字段 |
| 完整 Schema | [Introspection](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/introspection/) 与 [Schema explorer](https://developers.cloudflare.com/analytics/graphql-api/getting-started/explore-graphql-schema/) 指向认证 schema discovery。WAF groups Host dimension、groups/sample 精确 Host filter、count/字段 nullability、orderBy 和变量标量仍需官方导出核验 |
| 平台限额 | [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/) 列出默认 300 queries/5min、单请求 scope×node 数限制；不能把一个含 alias 的 HTTP 当成一个低成本 node，也不宣称 7 aliases 对任何套餐都合法 |
| Zone 限额 | [Settings](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/) 提供 enabled、availableFields、maxPageSize、maxNumberOfFields、maxDuration、notOlderThan；这些值依目标 Zone/套餐而定，当前未认证核验 |
| 采样 | [Sampling](https://developers.cloudflare.com/analytics/graphql-api/sampling/) 说明 Adaptive 数据可能是估计值；保持同一窗口并不保证不同查询估计完全一致 |

实施前门禁：取得由官方 endpoint 导出的脱敏 Schema/settings 片段，验证 `firewallEventsAdaptiveGroups` 的 count、dimensions 中 Host/IP/Path/Country/ASN/action/source，以及 `firewallEventsAdaptive` 的九个现有字段；验证两者 input filter 中 Host 精确等值及 datetime_geq/leq、排序与 limit 标量。候选过滤为 `{datetime_geq: start, datetime_leq: end, clientRequestHTTPHost: host}`，变量使用 Schema 的真实类型，不照搬现有 `String!`/`Int!`。本轮不将该候选标为可执行查询。若字段或 7 aliases/请求不支持，停止该实现任务，先修订预算/方案并再审阅，禁止猜字段或换数据集后沿用原统计口径。不得在每条告警中执行 discovery/settings 探测。

### 请求、并发与截止预算

- 发现阶段：1 HTTP，2 group aliases（total、topHosts limit=10）。Host 阶段每 Host 2 HTTP：7 group aliases（total、IP、Path、Country、ASN、Action、Source）与 1 samples node；不再查询 Host 内 Top Host。
- 每 Host IP/Path/Country/ASN 采集 limit=10，Action/Source limit=20；样本最多 `sampleLimit`（默认每 Host 50，最大 100）。这些为应用预算，需通过上述远端限额门禁。
- H=3 时正常 GraphQL HTTP=7、node selections=26、样本最多150；H=5 时 HTTP=11、node selections=42、样本最多500。节点数不代表服务端正式 cost 单位；跨告警共享配额，没有新增全局限流存储。
- 最多两个 Host 工作通道，通道内 aggregates -> samples 串行，故 GraphQL HTTP 并发上限2（包括重试），发现阶段串行。Host aggregate 失败不再发该 Host samples，其他 Host 继续。
- 单次尝试沿用 requestTimeoutMs；HTTP timeout/network/429/5xx 至多 retryCount 次（1～2），100/200ms 有界技术退避，复用完全相同的 zone/window/host/limit；不等待数据成熟，不因空结果再发请求。
- GraphQL 整阶段硬截止90秒，attempt timeout=min(requestTimeoutMs, remaining)，退避和响应体读取均计入，截止取消在途并将未完成项标为 `collection_budget_exhausted`；不能后台继续请求。预算为内部固定常量，不新增配置组合。
- GraphQL 最坏 HTTP 上限 `3*(1+2H)`，默认21、最大33；LLM 为一个逻辑调用、HTTP最多2（仅429/5xx），WeCom最多3。最大总 HTTP=38。90秒采集 + LLM总截止最多120秒 + WeCom最多90.3秒，外部阶段约300.3秒，尚须测试 CPU/格式化开销；远端运行验收不由此次规划代替。
- HTTP200 的任何非空 GraphQL errors 使本次操作失败，即使 data 部分可用也不接受同一响应的残缺 alias。保留现有 GraphQL errors 不自动重试策略；HTTP明确临时错误才有限重试，字段/鉴权/Schema失败不重试。

## 组件与边界

| 模块 | 改动与调用方 |
| --- | --- |
| GraphQL Client/Schema/contracts | `discoverZone(input)` 与 `collectHostSnapshot(input, host)`，返回已验证 DTO；Client 管请求/传输预算，不判风险 |
| WAF Analyzer | 发现、选择、有限并发、按 Host 归并结果；各 Host 仅标准化/计算一次 |
| Incident/Statistics/Finding | Incident 持有 Zone 元数据及 Host collection；Statistics/Finding 带 hostId，独立总量与状态 |
| analysis/normalizer/statistics/rules | 复用 count/ratio/阈值纯函数；显式输入 Host，防止误传 Zone 分母；新增纯函数 `calculateRuleAttention` 统一规则等级 |
| evidence-catalog/evidence/ai-analyzer | Host namespace、来源/分母验证、局部降级；同一目录不可被跨 Incident 复用 |
| LLM Client | 只负责请求、协议/外层解析与逐项结构结果，不负责支持判断；严格 Provider schema 同源 |
| Formatter | 消费已验证结果、原 Statistics/Findings；模板、完整区块、预算和集中建议；不重查、不重算规则 |
| config/window/queue/pipeline | hostLimit 快照、旧消息默认、状态与安全日志传播；window 等式不变 |
| observability | 有界 host_id、阶段与计数/状态；不记录 Host 原值、IP/Path、Prompt、模型原文或任意 Zod issue |

GraphQL Client 采用明确的两个操作，不保留两套 Zone/Host 运行链。复用原统计的数学 helper 而非构造假 Zone Incident 来适配。必要的小型 Host Schema 放在 `src/domain/host-analysis.ts`，预算纯函数放在 `src/notification/blocks.ts`；不引入注册表、通用工作流或动态策略引擎。

### GitNexus 与人工核对

初始索引 `cdaf7dc` 落后于 `ce86425`；刷新使用 `--skip-agents-md --skip-skills`，成功后1314 nodes、2297 edges、74 flows。query 命中 `processMessage -> processAlert -> analyzeWafAlert -> collectSnapshot` 及失败日志链。

| impact目标 | 图结果 | 源码核对与验收范围 |
| --- | --- | --- |
| buildEvidenceCatalog | CRITICAL，6受影响、3直接、5流程/3模块 | runAIAnalysis与catalogMatchesSnapshot直接调用，延伸Formatter/processAlert；目录品牌、同快照匹配及局部降级必须同时迁移 |
| calculateStatistics / evaluateRules | 各HIGH，1直接、3流程 | analyzeWafAlert调用；Host分母测试与pipeline重试/调用次数回归不可省略 |
| collectSnapshot（contracts接口消歧后） | HIGH，1直接、3流程 | analyzeWafAlert及processAlert入口链；必须迁移接口Mock与两个新采集操作 |
| validateAIAnalysisEvidence | LOW，2直接、2流程 | runAIAnalysis支持验证及冻结结果消费仍属安全关键，评分不降低测试要求 |
| analyzeWafAlert / formatWeComMessage / buildQueueMessage | LOW，图显示0 | 源码分别由processAlert、processAlert、api/cloudflare-alert调用，说明图不完整 |
| Incident/Statistics/Finding/AIAnalysisWire/QueueMessage/EvidenceCatalog Schema | 常量图显示0或重复候选 | rg核对normalizer、statistics、rules、LLM、Catalog、window、queue-handler及fixtures，类型依赖不可只看callgraph |

HIGH/CRITICAL已在规划阶段报告，用户已审阅并授权本设计范围内实施。主源码调用方均落在本设计范围；仍需typecheck和Workers全量回归，不能声称图覆盖所有TypeScript依赖。

## 数据与接口契约

### Queue 与配置

`BUSINESS_CONFIG.hostLimit` 整数1..5、默认3，写入 `configSnapshot.hostLimit`。保留 Queue schemaVersion=1；输入缺失时使用固定3，不读取消费时 env 默认。`sampleLimit` 继续快照，含义升级为每 Host 上限。未改变其他 vars 的 Queue 快照范围：超时/token/display/rules 仍从当前运行配置取值，与现状一致。

`validateFixedWindow` 继续校验已保存等式，所有查询直接复用字符串，不以 processingStartedAt、当前时间或重试轮次计算新窗口。技术重放可能因上游迟到数据得到不同排名；无存储不能保证值/Host集合跨投递一致，只保证原 Zone、窗口和参数，明确至少一次语义。

### 领域 DTO

```text
Incident: 原 incidentId/correlationId/zoneTag/resource/alertTime/queryStartedAt/
          analysisWindow/payloadEventsCount/dashboardLink + zone + hosts[]
ZoneOverview: zoneTotalEvents, discoveredHosts[{host, discoveryCount}],
              selectedHostCount, analyzedHostCount, failedHostCount,
              sampleFailedHostCount, qualityFailedHostCount, topHostsTruncated, invalidHostEvents,
              coverage{events: number|null, ratio: number|null,
                       status: comparable|inconsistent|unavailable|empty}
HostCollection: hostId, host, discoveryCount,
  collectionStatus: success|empty|partial|failed,
  hostTotalEvents: number|null,
  aggregates: {topIps,topPaths,topCountries,topAsns,actions,sources}|null,
  samples: SecurityEventSample[], samplesStatus: success|failed|not_requested,
  quality: {aggregateConsistent, discoveryConsistent, actionsComplete,
            sourcesComplete, reasons: controlled-enum[]}, failure?
HostAnalysis: collection + statistics: Statistics|null + findings: Finding[]
              + ruleAttention: LOW|MEDIUM|HIGH|Unknown
Statistics: hostId, totalEvents (= hostTotalEvents), zoneShare: number|null,
            原集中度/Action比例/UA/速率/dataSufficient + nonEmptyUaSampleCount
Finding: hostId + 原 type/level/value/threshold/evidence
```

Zod 是唯一类型来源；`collectionStatus=failed` 不得使用 total=0，未得到该 Host total 则 null，discoveryCount 单独保留。samplesStatus=failed 时 samples=[] 只是缺数据容器，不可解读为“观察到零样本”。原快照结果外层扩展为 success/partial/empty/collection_failed；Zone发现失败为 collection_failed，其余根据 Host 状态汇总，即使所有 Host failed 也保留 Zone 概览。

### Host 选择与计数质量

1. Host 使用 GraphQL 精确原值，不把根域/www、大小写、尾点、端口或 Unicode 自动合并。null/空串/纯空白视为无归属，不生成“未知 Host”过滤请求；记录可得 count，不用 Zone 名补齐。重复 Host 分组视为响应无效，不求和掩盖异常。
2. 发现返回最多10条，按 count 降序、原始 host 的固定字典序决胜，从有效且 count>0 者选前 hostLimit。服务端截断边界并列无法保证完整排名，显示“Top Host 范围有限”，不分页、不替换失败项、不编造总 Host 数。
3. `topHostsTruncated=true` 当返回10条或有效候选超过 hostLimit；空 Host/无效值产生独立未覆盖原因。始终只说“已分析 N 个 Host，另有 M 个采集失败”；不以候选数组长度当总数。
4. Host 内四维比例、Action/Source 比例只除以 hostTotalEvents；zoneShare 只除以 zoneTotalEvents。UA 忽略 null/空串/纯空白，但保留其他 UA 原值，以该 Host 原始有界样本中的非空数量为分母，不以送 AI 的裁剪样本数为分母。速率为 hostTotalEvents / 原窗口秒数；窗口零秒返回 null，非业务 QPS/峰值。
5. count 非负安全整数；total 数组空表示有效零（前提为 zone 节点存在、无 errors、其他集合为空），节点缺失、负数/非法形状为失败。Host total=0 且存在正聚合/样本为不一致，不伪装正常空快照；Zone total=0 且有正 Host count 亦不一致，不发 Host 查询或 LLM。
6. 只对可靠聚合产生比例。四维各自截断，sum<Host total 正常，不补全；任一项或同维 sum>Host total 标记该维不一致、对应统计=null。Action/Source 若返回20项视为可能截断；即使 sum=total 也不宣称完整。未触及上限且 sum=total 才 complete；否则对应比例置null、标注口径不一致或截断。绝不换用分类和当分母或 clamp 到100%。
7. Host total 与 discoveryCount 不同不触发补查，保留两个值；不影响内部一致的 Host 统计，但该 Host zoneShare=null、整个 coverage=null，显示“聚合口径不一致，覆盖比例无法可靠计算”。若任一已取得Host聚合的quality不一致，coverage同样为null；其他Host可核验比例仍保留。只有各成功获取完整一致聚合的 Host 与发现计数一致且其和<=Zone total，coverage.events=sum(hostTotalEvents)，ratio=events/Zone total；失败 Host 不计，samples 失败但聚合一致可计。已分析数含完整一致聚合成功的 success/partial/empty Host；质量不一致 Host计入qualityFailedHostCount并显示“另有N个数据不完整”，不与failedHostCount重复。Zone发现的各Host计数总和超过Zone总量也使coverage不可比较，不能以只取少数Host掩盖发现数据异常。
8. Zone零事件时 analyzed=0，覆盖比例=null（显示“不适用”），不写0%或100%；Zone失败为“未知”。采样/Dashboard差异仅解释不补采。正常覆盖称“按快照聚合估计”，无 Host 总数输出。

### 规则关注等级

把现有风险资格与最高等级提取为程序纯函数并用于 AI/降级两条路径：riskAssessable 仍要求正总量、统计/Finding投影完整、IP/Path/Country/ASN/allow/block/challenge/rate均非null且 Findings 不全unknown。质量不一致影响相应统计并使资格失败。风险集合仅 ip/path/country/asn/allow/request_rate，最高 high=>HIGH、medium=>MEDIUM，无命中=>LOW；资格不够=>Unknown。block 与 UA Finding 不单独抬高风险。AI Unknown 允许保守弃权，但不覆盖已经计算出的“规则关注等级”，显示“AI未作判断”而不是降低程序等级。

### Catalog v2 与支持验证

- `version=2`，保留 context/aggregate/sample 的原 scope（数据口径），另加 `owner:{kind:zone}` 或 `{kind:host,hostId}`。hostId 使用 `h0`..`h4`，按选择顺序固定；ID 如 `zone:total`、`h0:stat:path`、`h0:finding:path_concentration`。Host 原值映射在 context，模型只输出 host_id，不重复实体。
- Zone namespace 只含上下文、总量、发现/覆盖事实；Host 声明只能引用同 Host namespace，连 context 也使用同 Host context（带相同窗口）。不以 Zone total 支持 Host 比例，不允许跨 Host 的 total/stat/Finding/sample。Zone 证据不支持 Host 风险或攻击判断。
- 每个比例 entry 带 denominatorKind、denominator、denominatorId；UA denominatorKind=host_nonempty_ua_samples；速率带 windowSeconds/contextId。目录构造验证 count/total 对应及沿用统计精度的公式、Finding statId/value/threshold，禁止仅核对实体是否相同。这属于程序来源一致性验证，不让 LLM 重算统计。
- 每 Host 至多64项：context/quality/total=3、六维各最多5项=30、原九项统计=9、八类Finding=8、样本最多5=5，共最多55，留少量严格类型空间但不新增事实类型；Zone最多8，全部最多328项。单字符串上限仍2048 bytes；Host JSON硬上限10 KiB、完整 Catalog 56 KiB、序列化 messages内容（system+user）64 KiB、完整HTTP body含Provider schema硬上限96 KiB。
- 优先保留 context/quality/total、全部已有统计与其Finding闭包，再保留每维Top1，再轮询加入其余聚合与样本。超长值整项省略并移除依赖，更新 omitted；核心统计/Finding被省略则 catalogComplete=false。若必需 context 超限或最小目录仍超10 KiB，仅该Host catalog_failed，不调用它的AI；其他Host继续。根上下文/总预算失败则整个AI降级。
- namespace内 ID 用原索引，不因裁剪重新编号；同输入/版本必定稳定，跨投递不承诺ID稳定。保留冻结目录和已验证对象的绑定/品牌验证，拒绝跨Incident复用。
- 样本须有与 Host 精确匹配的 clientRequestHTTPHost，缺失/不同属响应校验失败，只使该 Host samplesStatus=failed。样本字段共现只可描述一条事件，不外推联合总体；AI无需也不得返回 Host+ASN+Path 等关系节点。

### AI 输出 v3 与预算

```text
schema_version: 3
hosts: [{host_id: h0..h4,
         risk: {level, evidence_ids[0..4]},
         attack: {type, confidence, evidence_ids[0..4]},
         observations: 原受控kind/dimension/evidence_ids[0..4], 数量0..3,
         recommendations: 原受控kind/evidence_ids[0..4], 数量1..2}]
```

每Host最多28引用，全体最多140；根数组1..5，只请求聚合非零且可构造目录的 Host，样本失败可保留有限统计但 Bot 无资格。无合格 Host 则LLM=0。一次逻辑调用默认输出token仍2048，上限沿用配置8192，不因H放大或新增请求；最大配置5 Host可能更易截断，截断整体降级。HTTP响应读取硬上限128 KiB、message.content上限32 KiB，超限整体降级；字节预算不是Provider token估算，需未来受控兼容验证，禁止声称已验证真实模型。

Provider schema 从严格 v3 Zod wire schema生成。Client 对JSON根先做严格envelope检查（只有schema_version/hosts），再校验每个可定位的Host项并返回类型化成功/失败DTO供AI Analyzer支持验证：不得因provider严格schema而省略本地验证，也不能以宽松parse后strip未知字段接受模型内容。

- 根版本/字段/hosts类型或上限错误、非JSON、truncated/refusal、重复/未知host_id、缺失/非字符串host_id导致无法归属：全体请求Host AI降级。
- 已知唯一host_id内部字段/引用/支持错误（含额外自由字段）：该Host整个AI结果降级，不部分接受该Host结论；其他合格项保留。缺少某预期Host项：仅该Host `ai_host_missing`。模型省略所有项（hosts=[]）为根结构失败。
- schema合法但跨Host引用使用 `ai_reference_invalid/host_mismatch`；错误分母为 `ai_catalog_invalid/inconsistent_source`；不支持联合关系/攻击为原支持失败。失败不修复prompt、不重查、不重算统计；只保留现有HTTP429/5xx最多一次重试和统一LLM截止。
- 完整保留旧支持表：精确角色数、Finding+stat配对与阈值、最高规则等级、Unknown空引用/attack confidence=0、不支持CRITICAL及除Bot之外具体攻击。Bot仍要求同Host >=10非空UA样本、UA和rate均high、riskAssessable、confidence>0且<=0.6。样本stat不能冒充总体，独立ASN/IP/Path排名没有联合关系表达通道。
- 模型文本永不进入Formatter/日志。单Host降级时规则等级来自程序，不自动Unknown掩盖已有合法高关注事实；攻击判断Unknown。

## 错误处理

| 失败位置 | 保留事实与后续行为 |
| --- | --- |
| Zone发现失败/无zone/Schema错误 | 基础采集失败通知，Host查询=0、LLM=0，总量未知 |
| 单Host aggregates失败 | 该Host failed、总量未知、只保留发现计数；不发该Host样本/AI；其他Host继续 |
| 单Host samples失败 | partial，保留聚合/统计/规则；UA=null，无Bot，显示样本采集失败 |
| 计数不一致/截断 | 保留有来源的计数和质量标记，对应比例null；规则Unknown资格保守处理，不补查 |
| 单Host目录/AI失败 | 仅其AI降级；完整程序事实仍展示 |
| LLM整体失败/根结构失败 | 所有AI降级，成功采集的Host规则分析仍展示 |
| WeCom失败 | 同字符串有限重试；耗尽记录失败并ack，不重跑上游 |
| 成功后日志失败 | 吞掉观测异常，保持sent并ack |

日志新增受控 `host_id`、`collection_stage=discovery|aggregate|sample`、各状态数量、实际request_count/node_selection_count、coverage_status、ai_host_status、budget_exhausted；错误保留external_service/status/duration/error_code及原incident_id/correlation_id/window/queue_attempt。paths 只许 `hosts[].risk...` 等静态白名单，不写host实体、引用原文或LLM动态字段名；沿用敏感哨兵测试。意外基础设施失败仍按原Queue有限重放，不承诺exactly-once。

## 通知布局与预算

2026-09-29追加展示要求：区分建议来源。固定Dashboard核验提示使用“人工核验处理建议”（整体AI不可用时为“规则分析处理建议”），已校验且非manual_dashboard的模型建议使用独立“AI 分析处理建议”。AI标题与最多两条去重建议合为可选原子区块，预算不足整块省略，不留下空标题，不将固定提示标为模型结论。

单条 `text`。按2026-09-29用户指定排版，标题“Cloudflare WAF 告警”；Host加“一：”至“五：”中文显示序号，维度标签独行、明细另行并按同类归组。隐藏规则关注等级及攻击Unknown占位，内部等级、排序和支持校验不变。比例 `.toFixed(1)`；保留降级状态、失败原因和必要判断限定语。

排序：规则HIGH、MEDIUM、Unknown、LOW，同等级按discoveryCount降序再按host原值；failed的等级Unknown，不因失败消失。hostId始终为原发现排序，与展示排序分离。Zone不合成“最高攻击等级”。

防护结果优先：Action完整且精确blockCount==hostTotalEvents>0才说“本 Host 快照事件全部标记为 block”；不能根据显示四舍五入100.0%触发“全部”。否则显示已验证block/allow/challenge比例或“处理分布未完整获取”；没有“全部攻击已阻止”。Source取最高1项、中文标签加原枚举；不是IP/ASN联合归因。全局一次保留“各排名相互独立，事件可能采样”。LOW附“不代表安全”；Bot整块绑定“疑似/待核验/模型自评非概率”，不可只留Bot标题。

预算算法由纯函数处理完整区块：

1. 先预留Zone标题/事件总量、所有选中Host最小块（中文序号、标识、防护/不可用、降级/采集状态）、至少一条集中人工核验建议及Dashboard链接、全局判断限定语、告警时间/窗口/数据截至/时区、覆盖与两个完整ID。用实际UTF-8计数，含换行；不得裁切ID。
2. 常规每Host详细块IP/Path最多3，Country/ASN最多1，Source最多1；先给每Host均等剩余字节份额，无法使用的份额按展示顺序轮询再分配。IP、Path、Country、ASN、Source按完整维度块加入，标签和明细一起保留或省略，随后考虑AI非重复观察及额外建议。
3. 仅保留不重复的AI观察，不再单列摘要+Evidence重复区。所有建议最后集中，保留Host归属。必需兜底“按相同窗口人工核验 Cloudflare Dashboard”及链接：使用告警携带的不超过300字符、无userinfo/非默认端口的HTTPS dash.cloudflare.com URL，否则回退https://dash.cloudflare.com/。无账户上下文时不拼造专属地址。
4. 超预算按公平份额省略完整维度或额外观察/建议，每个被省略Host细节使用一次“明细已省略”；不得省略选中Host存在与失败状态。长Zone/Host/实体整值显式占位，不输出貌似完整的前缀域名；日志只以h0关联。覆盖去掉重复的“仅分析所选Host”，截断和口径不一致仍明确保留。
5. 字节硬上限2000，同时遵守现有maxLength字符限制。任意输入的无限长ID与2000上限不可同时满足：新Webhook入队前增加两个ID的UTF-8上限各128 bytes（超出返回400，不截断、不换ID），在proposal/spec明确这是兼容性收紧。旧Queue不强行施加该上限；若含超长ID导致最低消息仍放不下，返回受控 `notification_content_unrepresentable`，不发送缺追踪信息的通知，记录安全错误并ack。极小maxLength同样受控失败，不返回空字符串冒充成功。这是少数不可表示历史输入的明确限制。

### 四类虚构通知示例

下列均为设计示例，非运行输出；使用保留域名、文档IP/私有ASN。关注高假定该Host合法完整统计达到现有阈值；示例未显示的聚合仍存在于输入。正常原输入可有Top3，按各Host预算只示意实际容纳的项。时间窗口均为1860秒；示例字节验证只检验设计文本。

#### 正常

```text
【Cloudflare WAF 告警】
Zone: example.test；快照事件: 1000
一：Host: example.test；600 事件，占 Zone 60.0%
防护: 本 Host 快照事件全部标记为 block
来源 IP:
[192.0.2.10] 360（60.0%）
目标路径:
[/login] 300（50.0%）
来源国家/地区:
[ZZ] 480（80.0%）
来源 ASN:
[AS64512] 420（70.0%）
触发来源:
[waf] 600（100.0%）
二：Host: www.example.test；300 事件，占 Zone 30.0%
防护: block 20.0%；allow 80.0%；challenge 0.0%
来源 IP:
[198.51.100.20] 180（60.0%）
目标路径:
[/login] 30（10.0%）
来源国家/地区:
[YY] 210（70.0%）
来源 ASN:
[AS64513] 180（60.0%）
触发来源:
[firewallrules] 300（100.0%）
处理建议:
人工核验 www.example.test 的现有 WAF 处理情况；按相同窗口核验 Dashboard。
https://dash.cloudflare.com/
各排名相互独立，事件可能采样。
告警时间: 2026-09-24 08:30:00 GMT+8
分析窗口: 2026-09-24 08:00:00 - 08:31:00 GMT+8
数据截至: 2026-09-24 08:31:00 GMT+8
覆盖: 已分析 2 个 Host；事件覆盖估计 90.0%
incident_id: demo-normal
correlation_id: demo-normal
```

#### 部分 Host 失败

```text
【Cloudflare WAF 告警】
Zone: example.test；快照事件: 1000
一：Host: example.test；600 事件，占 Zone 60.0%
防护: 本 Host 快照事件全部标记为 block
来源 IP:
[192.0.2.10] 360（60.0%）
目标路径:
[/login] 300（50.0%）
二：Host: www.example.test
防护: 未知
采集失败: Host 聚合超时；发现阶段记录 300 事件，未完成分析
处理建议:
按相同窗口人工核验 www.example.test 的 Cloudflare Dashboard。
https://dash.cloudflare.com/
各排名相互独立，事件可能采样。
告警时间: 2026-09-24 08:30:00 GMT+8
分析窗口: 2026-09-24 08:00:00 - 08:31:00 GMT+8
数据截至: 2026-09-24 08:31:00 GMT+8
覆盖: 已分析 1 个 Host，另有 1 个采集失败；事件覆盖估计 60.0%
incident_id: demo-partial
correlation_id: demo-partial
```

#### AI 降级

```text
【Cloudflare WAF 告警】
Zone: example.test；快照事件: 1000
一：Host: example.test；600 事件，占 Zone 60.0%
AI 降级，使用规则分析
防护: 本 Host 快照事件全部标记为 block
来源 IP:
[192.0.2.10] 360（60.0%）
目标路径:
[/login] 300（50.0%）
二：Host: www.example.test；300 事件，占 Zone 30.0%
AI 降级，使用规则分析
防护: block 20.0%；allow 80.0%；challenge 0.0%
来源 IP:
[198.51.100.20] 180（60.0%）
目标路径:
[/login] 30（10.0%）
处理建议:
按相同窗口人工核验 Cloudflare Dashboard；重点核对 www.example.test 的处理情况。
https://dash.cloudflare.com/
各排名相互独立，事件可能采样。
告警时间: 2026-09-24 08:30:00 GMT+8
分析窗口: 2026-09-24 08:00:00 - 08:31:00 GMT+8
数据截至: 2026-09-24 08:31:00 GMT+8
覆盖: 已分析 2 个 Host；事件覆盖估计 90.0%
incident_id: demo-ai-fallback
correlation_id: demo-ai-fallback
```

#### 超长内容

输入含5个Host及每Host超过2048 bytes的路径/UA，输出保留所有最小块，不显示截断路径。如下按事件数降序、同为高关注的压缩形式：

```text
【Cloudflare WAF 告警】
Zone: example.test；快照事件: 1500
一：Host: a.example.test；400 事件，占 Zone 26.7%
AI 降级
防护: 本 Host 快照事件全部标记为 block；明细已省略
二：Host: b.example.test；350 事件，占 Zone 23.3%
AI 降级
防护: 本 Host 快照事件全部标记为 block；明细已省略
三：Host: c.example.test；300 事件，占 Zone 20.0%
AI 降级
防护: 本 Host 快照事件全部标记为 block；明细已省略
四：Host: d.example.test；250 事件，占 Zone 16.7%
AI 降级
防护: 本 Host 快照事件全部标记为 block；明细已省略
五：Host: e.example.test；100 事件，占 Zone 6.7%
AI 降级
防护: 本 Host 快照事件全部标记为 block；明细已省略
处理建议:
按相同窗口人工核验 Cloudflare Dashboard。
https://dash.cloudflare.com/
各排名相互独立，事件可能采样。
告警时间: 2026-09-24 08:30:00 GMT+8
分析窗口: 2026-09-24 08:00:00 - 08:31:00 GMT+8
数据截至: 2026-09-24 08:31:00 GMT+8
覆盖: 已分析 5 个 Host；事件覆盖估计 93.3%；Top Host 范围有限
incident_id: demo-long
correlation_id: demo-long
```

## 兼容与恢复

### 与未归档 Changes 的关系

| 原 Change/Requirement | 本 Change 生效后的关系 |
| --- | --- |
| MVP：One-shot snapshot / Bounded GraphQL collection / Incident normalization / Deterministic statistics/findings | 保留固定窗口与有限重试，替换为分阶段Host集合、Host分母与局部失败；Payload仍参考 |
| MVP：Queue/ingestion与配置 | schemaVersion1加hostLimit默认；新增入队ID128 bytes上限；测试握手/202/失败语义保留 |
| MVP：Required notification content / Message length control | 本设计布局/最小块替代旧必备摘要+Evidence+每维列表/Dashboard；完整ID与窗口优先 |
| optimize：token/timeout/retry/diagnostics | 继承其已实施有效契约，不恢复被structured change替代的自由文本或旧实体扫描 |
| structured：Bounded derived catalog / Closed output / Reference support | Catalog2/AI3及Host命名空间替代Catalog1/AI2；支持表沿用并附Host/分母限制 |
| structured：Program-rendered notification / Failure isolation | 模板信任边界继承；重复摘要删除、整体失败改为可定位Host局部失败，根无效仍全体降级 |

主Specs当前为空，使用单一ADDED能力，不向不存在的主能力写MODIFIED。未来获单独同步指令后，先确认MVP剩余3任务状态，再按MVP -> optimize -> structured -> 本Change整理规范；旧冲突条款必须删除或指向后继，不能盲目依次覆盖。这里的继承说明不将前序未完成项标为完成，不修改其artifacts。

### Migration Plan

用户已批准本Change实施，执行记录见verification.md。完成所有TDD与离线Workers验证后，才考虑另获授权的发布。Queue旧v1缺hostLimit固定3；新v1多字段被当前旧Consumer的非strict对象strip，旧版本仍能处理窗口和sampleLimit。测试必须以实际旧Schema夹具验证，不能口头宣称双向兼容。

Prompt/Catalog/AI输出/校验/Formatter/Client/DTO/配置同包上线；旧AI输出不转换、不双跑。旧Worker正在执行的请求在其版本内完成，新Consumer只生成v3。回滚整包到已知版本，Queue无需清空或资源变更，但旧Consumer会回到Zone级统计、忽略hostLimit，恢复旧通知缺陷；回滚期间可能跨版本重复通知，仍用稳定ID识别。不回滚到structured之前的自由文本分析版本。

原ID缺上限，新增入队约束属于有意兼容性收紧；历史不可表示消息受控ack不发送，必须计数告警，不能声称所有任意长度输入都可通知。默认正常ID/最长合法ID在5Host最小布局均须通过2000字节测试。

## Risks / Trade-offs

- 有限Host仅覆盖部分事件：展示实际数与可信覆盖，不编造Host总数。
- 采样估计不一致：不补查、不改分母、未知比例；保留可独立核验Host结果。
- 默认输出2048 tokens可能容不下5Host：保持有界请求与全体结构失败降级，未来真实Provider兼容需授权，不能用修复性重试扩预算。
- 单通知无法完整呈现所有维度：牺牲低优先级细节、保留状态/保护结果/追踪，明确省略。
- 已获授权核验目标Zone的Schema/settings与7alias空结果请求。该证据不代表其他Zone套餐权限，也不代表真实流量下不会发生配额/复杂度/超时；其他部署目标仍须单独核验。

## 测试计划

虚构夹具Zone=1000、HostA=600、HostB=300、剩余100；相同`/login`分别300与30，IP/ASN/Action分别不同。断言Path为50%与10%，不是30%与3%；coverage=90%，平均速率600/1860与300/1860；样本UA6/10=60%，裁剪到5条仍分母10。

覆盖hostLimit默认/1/5/0/6/小数、旧消息、部署配置变化后重试、所有HTTP变量完全一致；空Host/并列/Top10截断/零/负数/重复/计数不一致；aggregate与samples各自失败；取消和超时/请求上界；跨Host/Zone分母/错误Finding/sample/独立ASN+Path联合关系拒绝；Bot9/10/置信度边界不变；局部AI结构错/缺项/跨引用和根错/重复Host/非JSON/truncation；目录/输入/输出预算；所有Host保留、四类例子、控制符、中文/emoji UTF-8 1999/2000/2001边界、长ID/极小maxLength受控失败；WeCom同文本重试与成功后logger失败ack；不调用真实网络、敏感哨兵不进日志。

## 审阅与实施门禁

默认3/上限5、Host样本预算、90秒截止、保守口径策略、局部降级和ID边界已经用户审阅批准。官方Schema/settings与空结果预算门禁已完成；真实v3 Provider/非生产机器人及部署验收仍是后续另行授权的发布门禁。本次只执行已授权只读核验与本地实现验证，不增加云资源。
