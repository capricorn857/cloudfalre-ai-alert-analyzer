# 设计说明：结构化证据引用

## Context

动机与授权见 proposal.md。核对基线为 `cdaf7dc`：`LLMClient.analyze` 当前同时做协议、结构和自然语言证据校验；`runAIAnalysis` 仅再做结构校验，替换 Client 可绕开领域校验。Formatter 直接显示通过 Schema 的模型字符串。Statistics 已提供总体集中度、Action 比例、样本 UA 集中度和窗口平均事件速率，Finding 已提供 type/level/value/threshold，故无需新增查询或统计计算。

当前 `dataSufficient` 仅表示 totalEvents > 0，不能解释为足以确认具体攻击。UA 比例分母是非空 UA 样本数，不是全部样本，更不是 totalEvents。`Finding.evidence` 是程序生成的展示文本，本方案不解析它反推事实。

## Goals / Non-Goals

建立可审计的有限表达语言：模型选择观察和建议，程序决定哪些类型有资格展示及其具体文案。目录仅为现有输入的派生视图，不取代 Incident / Statistics / Findings；不引入通用证据数据库、动态脚本或第二个审查模型。

## 总体方案

### 方案比较与决定

| 方案 | 收益 | 代价 / 缺陷 |
| --- | --- | --- |
| A：自由文本 + evidenceIds | 改动较小 | 无法阻止真实引用配无关结论，需要保留不可靠的语义审查 |
| B：受控类型 + 引用角色 + 确定性策略 + 模板（推荐） | 无模型自由事实通道，拒绝可枚举的不支持关系，测试可穷举 | 表达范围变窄；新攻击类型须新增支持策略与测试 |
| C：引用后再调用 LLM 复核 | 能处理开放语义 | 增加耗时、成本、失败面，仍非确定性保证 |

采用 B。不保留任何模型生成的 summary、reason、rationale、evidence text 或 recommendation text。结构化参数仅含受控枚举（观察类型/维度），实体和数值只用目录 ID 表达。

### 新旧数据流

```text
旧：Incident + Statistics + Findings
      -> LLMClient(JSON + Zod + 正则实体扫描)
      -> runAIAnalysis(Zod)
      -> Formatter(模型 summary/evidence/recommendations 字符串)

新：Incident + Statistics + Findings（现有单次分析产物）
      -> runAIAnalysis
         -> buildEvidenceCatalog -> Catalog Zod + 来源一致性校验
         -> LLMClient(Catalog + 受控契约 -> JSON -> 输出 Zod)
         -> validateAIAnalysisEvidence(目录查找 + 支持策略)
         -> ValidatedAIAnalysis(冻结的同一目录 + 已验证 AIAnalysis)
      -> Formatter(程序事实 + 受控类型模板 + 目录具体值)

任一目录/LLM/引用失败 -> unavailable -> 原 Statistics / Findings 规则降级
      -> 企微有限发送重试 -> Queue ack
```

目录不进入 Queue、不跨消息复用、不重新查询或重算 Statistics。单次消费内校验和 Formatter 使用同一个只读目录，避免引用绑定到另一份数据。

## 组件与边界

| 文件 | 职责与接口 |
| --- | --- |
| 新 `src/domain/evidence-catalog.ts` | `EvidenceCatalogSchema`、带 type/source/scope/value 的判别联合及推导类型 |
| 新 `src/analysis/evidence-catalog.ts` | `buildEvidenceCatalog(input: AIAnalysisInput): EvidenceCatalog`，纯函数，固定顺序投影/限额/完整性检查 |
| `src/domain/ai-analysis.ts` | 无 transform/refinement 的严格 wire Schema、由其映射的 camelCase `AIAnalysisSchema`、只供验证器构造的 `ValidatedAIAnalysis` 类型 |
| `src/analysis/evidence.ts` | 保留 `AIAnalysisInput` 的三个现有领域输入；将 `validateAIAnalysisEvidence(analysis, catalog)` 改为返回已验证结果；删除实体和自动动作自然语言正则 |
| `src/analysis/ai-analyzer.ts` | 唯一公共语义门禁；目录生成、Client 调用、再次结构校验、支持验证、失败隔离；即使测试 Client 或其他 Client 返回结果也不能绕过 |
| `src/clients/contracts.ts` | `AIAnalysisClient.analyze(input: EvidenceCatalog): Promise<AIAnalysis>`；Client 返回结构有效结果，不冒充已语义验证 |
| `src/clients/llm.ts` | HTTP/envelope/JSON/wire Zod，camelCase 映射；用目录作为唯一业务数据输入；保持现有超时与 429/5xx 一次重试 |
| `src/notification/formatter.ts` | available 分支仅接受 `ValidatedAIAnalysis`，从绑定目录读取值；通用事实和降级继续来自 snapshot |
| `src/observability/errors.ts`、`logger.ts` | 受控诊断 DTO、稳定 code/reason、路径白名单及数量限制 |
| `src/pipeline/process-alert.ts` | 映射新诊断字段，不承担引用校验；现有 send/ack/失败隔离保持 |

不修改 `calculateStatistics`、`evaluateRules` 的算法或阈值，不修改 Handler、GraphQL 和 Queue Message。必要的 imports/类型消费者及测试在同一变更内迁移。

### 规划阶段影响分析记录

2026-09-23 在 master / cdaf7dc 刷新索引后，`gitnexus status` 显示 up-to-date。刷新命令退出码为 1 且无诊断，因此不把刷新进程本身记录为成功；后续 status 与 impact 可读是以下分析的依据。

| 符号 | GitNexus risk / impactedCount | 范围处理 |
| --- | --- | --- |
| AppError | CRITICAL / 29（直接 18） | Clients、Pipeline、Analysis，涉及 collectSnapshot/analyze/send/processAlert；仅添加可选受控诊断，不改构造器既有参数、HTTP/传输分类或 retryable 语义 |
| toExternalFailure | HIGH / 4（直接 3） | WAF Analyzer、AI Analyzer、Pipeline；保持 GraphQL/WeCom 的既有投影行为，新增字段必须可选 |
| AIAnalysisClient | MEDIUM / 8（直接 5） | 新 Catalog 输入契约连同依赖注入与所有 mock 消费者一起迁移 |
| AIAnalysisSchema、validateAIAnalysisEvidence、runAIAnalysis、formatWeComMessage、createLogger | LOW / 0 | 源码存在明确调用关系，不能把图的 0 当作无影响；按本设计模块表人工复核 |

因此本方案包含高影响共享诊断契约，需随 artifacts 一起由用户确认。现有 GraphQL/WeCom 错误、通知失败、Queue、日志错误测试均列入全量回归；不据此授权重构这些客户端。实施前重跑，新增超范围影响再回到范围确认。本轮未改生产代码，detect-changes 不能替代后续实施验收。

## 数据与接口契约

### 1. Evidence Catalog v1

根对象为严格结构：`{ version: 1, entries: EvidenceEntry[], omitted: OmissionCounts }`。OmissionCounts 使用固定计数字段 `aggregateItems`、`samples`、`oversizedValues`、`dependentItems`，不接受动态键。每项 `{id, type, source, scope, value}`，所有对象 strict，ID 唯一；type 决定 source、scope 和 value 的精确形状，不能任意交叉组合。

| type | source / scope | value 与上限 |
| --- | --- | --- |
| `context` | `incident.context` / `context` | resource、analysisWindow；1 项，不发送 zoneTag、原始 Payload 或 Credential |
| `quality` | `derived.quality` / `context` | dataSufficient、riskAssessable、catalogComplete、sampleCount、nonNullUaSampleCount；1 项；计数为投影元数据，不是新安全统计 |
| `total` | `statistics.totalEvents` / `aggregate` | totalEvents；1 项，须与 Incident 一致 |
| `aggregate_ip/path/host/country/asn/action/source` | `incident.evidence.<dimension>` / `aggregate` | `{value,count}` 原值；7 维各最多前 10 项 |
| `stat_ip/path/country/asn` | `statistics.topIp/topPath/topCountry/topAsn` / `aggregate` | 原 Concentration `{value,count,ratio}`；非 null 各 1 项 |
| `stat_allow/block/challenge` | `statistics.allowRatio/blockRatio/challengeRatio` / `aggregate` | `{ratio}`；非 null 各 1 项 |
| `stat_rate` | `statistics.requestRatePerSecond` / `aggregate` | `{eventsPerSecond}`；非 null 1 项，窗口来自 context |
| `stat_ua` | `statistics.userAgentConcentration` / `sample` | 原 `{value,count,ratio}` 加 `{denominator: nonNullUaSampleCount}`，1 项 |
| `finding` | `findings` / 由 findingType 固定 | `{findingType,level,value,threshold,statId}`；最多 8 项，UA 为 sample，其余 aggregate；不复制 evidence 文本 |
| `sample` | `incident.samples` / `sample` | 原 SecurityEventSample（保留 nullable）；最多前 10 项 |

最大条数：3 + 70 + 9 + 8 + 10 = 100。Catalog 编码后 UTF-8 JSON 最大 128 KiB；单个业务字符串最大 2048 UTF-8 bytes；不在超长字符串中裁剪出“新实体”。超限候选整项省略，记录计数；引用依赖被省略时一起省略 Finding。必需 context 若超限或输入模型不一致，返回 `ai_catalog_invalid` 并降级。最终仍超总预算也降级，不发送不完整 JSON。

同一输入及 catalog version，按固定类型顺序、原始数组顺序确定结果。ID 用程序常量组成，示例 `ctx:0`、`quality:0`、`total:0`、`agg:path:0`、`stat:path`、`finding:path_concentration`、`sample:0`。数组 ID 使用裁剪前原始索引，不因省略而重编号。相同值不同位置可有不同 ID；禁止重复 Finding type。ID 只在该次目录内有效，不承诺跨不同输入或数组重排稳定，不使用随机数、处理时间、locale 排序或实体字符串。允许 ID 的 ASCII 字符集 `[a-z0-9:_]`，长度 1..64；格式正则只校验 ID，不解析自然语言。

所有值逐字段复制，不去 query、不 decode/encode URL、不改变大小写、不做路径前缀匹配或 ASN 重写。聚合项先前如何标准化仍沿用现有 Incident；目录不扩大其含义。四个 top Statistics 的 value/count 必须与对应 Incident 第一项相等，UA count 不得超过非空 UA 样本数，total 一致；不重新计算统计比例来修正来源。Finding 通过 type 精确映射到 Statistics，要求 value 与对应 ratio/rate 严格相等；medium/high 要求 threshold 非 null 且 value >= threshold，unknown 要求 value/threshold 为 null。未知 Finding 不作为肯定结论证据；无法建立 stat 依赖的 unknown Finding 省略。自然缺失造成的 unknown 省略不计为裁剪损失，但通过缺失统计影响 riskAssessable；源输入不一致是目录错误，不算模型错误。

`stat_*` null 时不制造 0。`stat_ua` 的 denominator 必须等于原 Incident 中非 null UA 的数量，即使只向模型提供 10 条 sample 也不改变该分母。Catalog 不重新计算 UA 比例。聚合统计均标注为“本次 GraphQL 快照”，不承诺未采样真实流量；样本不能支持总体比例或行为普遍性。

`riskAssessable` 为程序策略资格，不代表攻击证据充分：dataSufficient=true、catalogComplete=true、四个聚合集中特征及 allow/block/challenge/rate 非 null，且不存在全为 unknown 的非空 Findings。任一条件不满足则为 false。完整目录不要求样本和 Top 列表完全传输；正常按 10 项截取记录 omitted，但 `catalogComplete` 仅表示九个 Statistics 与八类 Finding 的可用内容未因限额/超长/依赖省略。自然缺失的 Statistics 仍由 riskAssessable 检查。

### 2. 模型输出 v2

外部 snake_case 只在 wire 边界；内部 camelCase。所有键 required、所有对象 `additionalProperties:false`，不接收旧自由文本键，未知字段直接结构失败，不能 strip 后成功。模型不能重复填写实体、比例、count、阈值、路径或自造参数。

```text
schema_version: literal 2
risk: { level: LOW|MEDIUM|HIGH|CRITICAL|Unknown, evidence_ids: ID[0..4] }
attack: { type: Scanning|Brute Force|Credential Stuffing|API Abuse|Bot|Vulnerability Scanning|Unknown,
          confidence: number[0..1], evidence_ids: ID[0..4] }
observations: { kind: aggregate_concentration|action_ratio|request_rate|sample_ua_concentration|sample_observed|insufficient_data,
                dimension: ip|path|country|asn|allow|block|challenge|rate|ua|sample|none,
                evidence_ids: ID[0..4] }[0..6]
recommendations: { kind: review_source|review_target|review_waf|verify_sample|manual_dashboard,
                   evidence_ids: ID[0..4] }[1..3]
```

每个节点自己的 evidenceIds 必须集合唯一，跨节点复用允许。observations 不得重复相同 kind+dimension+引用集合，建议 kind 不重复。risk、attack 和每个 observation 均是独立结论，禁止用末尾统一列表替代。每节点最多 4 个，总上限 44；无动态事实参数或自由文本容器。

空引用仅允许 `risk.Unknown`、`attack.Unknown`（confidence 必须 0）、`insufficient_data/none`。Unknown 的引用必须恰好为空，文案为“当前证据未形成受支持判断”，不声称不存在攻击。`insufficient_data` 只有 dataSufficient=false 或 riskAssessable=false 或没有可支持攻击假设时可用，具体缺失说明由程序选择；Unknown 在充分数据下仍允许保守弃权。manual_dashboard 必须引用 context，不利用空引用绕过建议约束。

### 3. 确定性支持规则（规范性决策表）

验证顺序：输出结构 -> 重复/节点规则 -> ID 存在 -> 引用类型及精确角色数 -> 数据充分性 -> 支持条件。每条接受的引用必须占据一个规定角色；拒绝无关“凑数”证据。无自动补引用、去重、忽略错误项或部分接受；任一失败整体降级。

| 结论 / 建议 | 必需且仅允许的证据 | 必须满足 / 固定展示语义 |
| --- | --- | --- |
| aggregate_concentration + ip/path/country/asn | 对应 stat + 同类型 Finding + total | dataSufficient；Finding medium/high，stat/value/threshold 一致；只称“该维度集中度达到配置阈值”，不称该实体已恶意 |
| action_ratio + allow/block | 对应 stat + 对应 Finding + total | 同上；只称快照 Action 比例达到阈值；allow 不等于已绕过全部防护，block 不等于本系统已执行封禁 |
| action_ratio + challenge | stat_challenge + total | dataSufficient 且 ratio 非 null；只报告原比例，不声称异常（当前无 challenge Finding） |
| request_rate + rate | stat_rate + request_rate Finding + context | dataSufficient、medium/high；只称固定窗口平均 Security Events/s，不推断峰值、请求并发或业务请求总量 |
| sample_ua_concentration + ua | stat_ua + user_agent_concentration Finding | dataSufficient、medium/high、denominator>0；只称“非空 UA 样本中”集中，不转换为总体占比 |
| sample_observed + sample | 恰好一个 sample | 仅陈述该条事件原字段；不含比例、总体趋势、攻击归因；不能用 aggregate 代替单条联合事件 |
| insufficient_data + none | 空 | 按上节资格显示程序选择的 Unknown 原因 |
| risk HIGH/MEDIUM | quality + 一个风险 Finding + 其 stat | riskAssessable；风险集合限 ip/path/country/asn/allow/request_rate；按整个目录风险集合的最高 level 取 HIGH/MEDIUM；被引 Finding 必须达到该最高 level，不能选低等级掩盖更高等级 |
| risk LOW | quality + total | riskAssessable 且整个目录上述风险集合为空；文案“未命中当前关注规则”，不称安全或无攻击 |
| risk CRITICAL | 无可支持集合 | 当前输入无业务影响/严重性证据，一律 `ai_claim_unsupported`；不能由模型自报严重性 |
| attack Bot | stat_ua + UA Finding + stat_rate + rate Finding | dataSufficient、riskAssessable；两个 Finding 均 high；UA denominator >= 10；confidence > 0 且 <= 0.6；仅显示“疑似自动化特征（Bot，待人工核验）” |
| 其他非 Unknown 攻击类型 | 无可支持集合 | 当前无认证结果、漏洞命中、凭证或业务语义；即使引用真实 IP/登录路径也一律 `ai_claim_unsupported`，模型必须返回 Unknown |
| review_source | 恰好一个 aggregate_ip/country/asn | count>0，建议人工核验来源是否为正常业务；不要求先有攻击结论 |
| review_target | 恰好一个 aggregate_path/host | count>0，建议核验目标访问与业务日志；不生成 Rate Limit/WAF 配置语句 |
| review_waf | stat_allow + allow Finding + total | dataSufficient、medium/high；建议人工核对现有 WAF 处理情况，不声称已更改配置 |
| verify_sample | 恰好一个 sample 或 stat_ua | sample 原事件或 UA denominator>0；只建议核验这条样本/样本 UA 的业务来源 |
| manual_dashboard | context | 固定窗口人工核验；URL 来自 snapshot 已校验 dashboardLink，而非模型或 sample 字符串 |

Bot 的“10”和“0.6”是版本化的保守展示门槛，不是新统计算法或风险规则阈值；放宽须变更支持契约。中高规则阈值继续来自现有配置。置信度是模型对 Bot 假设的自评且受上限约束，不用于风险升级或事实支持，不表述为“攻击概率 60%”。Unknown 的 0 表示未作判断，不表示有统计意义的零概率。

### 4. 虚构示例

下列为一个目录的选定条目（其余按目录表生成；不是完整请求夹具），所有域名/IP/ASN 均虚构或文档保留值。示例 total=100，path=60，allow=80；完整 Statistics 与 Findings 一致且 riskAssessable=true。

```json
[
  {"id":"ctx:0","type":"context","source":"incident.context","scope":"context","value":{"resource":"example.test","analysisWindow":{"start":"2026-09-20T00:00:00Z","end":"2026-09-20T00:31:00Z"}}},
  {"id":"quality:0","type":"quality","source":"derived.quality","scope":"context","value":{"dataSufficient":true,"riskAssessable":true,"catalogComplete":true,"sampleCount":10,"nonNullUaSampleCount":10}},
  {"id":"total:0","type":"total","source":"statistics.totalEvents","scope":"aggregate","value":{"totalEvents":100}},
  {"id":"agg:ip:0","type":"aggregate_ip","source":"incident.evidence.topIps","scope":"aggregate","value":{"value":"192.0.2.10","count":60}},
  {"id":"agg:path:0","type":"aggregate_path","source":"incident.evidence.topPaths","scope":"aggregate","value":{"value":"/index.php?lang=中文&mode=View","count":60}},
  {"id":"stat:path","type":"stat_path","source":"statistics.topPath","scope":"aggregate","value":{"value":"/index.php?lang=中文&mode=View","count":60,"ratio":60}},
  {"id":"finding:path_concentration","type":"finding","source":"findings","scope":"aggregate","value":{"findingType":"path_concentration","level":"high","value":60,"threshold":50,"statId":"stat:path"}},
  {"id":"stat:allow","type":"stat_allow","source":"statistics.allowRatio","scope":"aggregate","value":{"ratio":80}},
  {"id":"finding:allow_ratio","type":"finding","source":"findings","scope":"aggregate","value":{"findingType":"allow_ratio","level":"high","value":80,"threshold":80,"statId":"stat:allow"}}
]
```

完整合法模型响应示例：

```json
{
  "schema_version": 2,
  "risk": {"level":"HIGH","evidence_ids":["quality:0","finding:allow_ratio","stat:allow"]},
  "attack": {"type":"Unknown","confidence":0,"evidence_ids":[]},
  "observations": [
    {"kind":"aggregate_concentration","dimension":"path","evidence_ids":["stat:path","finding:path_concentration","total:0"]},
    {"kind":"action_ratio","dimension":"allow","evidence_ids":["stat:allow","finding:allow_ratio","total:0"]}
  ],
  "recommendations": [
    {"kind":"review_target","evidence_ids":["agg:path:0"]},
    {"kind":"review_waf","evidence_ids":["stat:allow","finding:allow_ratio","total:0"]},
    {"kind":"manual_dashboard","evidence_ids":["ctx:0"]}
  ]
}
```

对应通知示例（Top 全部来自完整 snapshot；这里列出每维首项）：

```text
【Cloudflare WAF 安全告警】
域名: example.test
告警时间: 2026-09-20 08:30:00 GMT+8
分析窗口: 2026-09-20 08:00:00 - 08:31:00 GMT+8
数据截至: 2026-09-20 08:31:00 GMT+8
incident_id: demo-incident-001
correlation_id: demo-correlation-001
快照事件数: 100；Payload 参考事件数: 95
规则关注等级: HIGH；攻击类型: Unknown；置信度: 未作判断
Top IP: 192.0.2.10 60 (60%)
Top Country: ZZ 60 (60%)
Top ASN: 64512 60 (60%)
Top Path: /index.php?lang=中文&mode=View 60 (60%)
Cloudflare Action: allow 80 (80%)；block 20 (20%)
AI 分析（程序模板）:
本次快照的目标路径集中度及 allow 比例达到配置阈值，攻击类型尚无法判断。
Evidence:
- /index.php?lang=中文&mode=View：60 / 100，60%，达到 high 阈值 50%。
- allow：80%，达到 high 阈值 80%；不代表已确认攻击穿透。
建议:
1. 人工核验 /index.php?lang=中文&mode=View 的访问与业务日志。
2. 人工核对现有 WAF 处理情况。
3. 使用相同固定窗口核验 Cloudflare Dashboard。
Cloudflare Dashboard: https://dash.cloudflare.com/example
```

反例：`aggregate_concentration/path` 引用存在的 `stat:ua` 为类型不匹配；引用正确 path stat 但缺 path Finding 为支持证据缺失；引用 path Finding/value 未达 threshold 为目录无效；只凭 `/login` 引用返回 Brute Force 为 ai_claim_unsupported；样本含某 IP 不支持该 IP 占总体 60%。

### 5. Provider 与本地契约一致

使用已安装 Zod 4 的 `z.toJSONSchema` 从无 transform/refinement 的严格 wire Schema 生成 Provider JSON Schema；camelCase 映射在 parse 之后独立执行。测试断言请求 schema 与生成结果完全相同，并逐层检查 required、additionalProperties、enum、范围、数组和 ID 字符串边界。不得另手写一份 Provider Schema。

引用存在、集合唯一、跨字段关系与支持规则依赖目录，属于明确独立的本地语义层，不宣称 Provider JSON Schema 能完成。其约束以提示词受控说明提供，永远由本地验证兜底。Provider 若不支持某 Schema 关键字，保持失败降级，不悄悄删限制；兼容性问题须复核 artifacts。

## 错误处理

### 分类与优先级

| error_code | reason（固定枚举） | 阶段 |
| --- | --- | --- |
| `llm_output_not_json` / `llm_output_schema_invalid` | `invalid_json` / `invalid_shape` / `unknown_field` / `limit_exceeded` | parsing / schema |
| `ai_reference_invalid` | `duplicate_reference` / `duplicate_claim` / `duplicate_recommendation` / `reference_not_found` | reference |
| `ai_reference_type_mismatch` | `reference_type_mismatch` | reference |
| `ai_claim_unsupported` | `missing_support` / `unrelated_reference` / `support_condition_failed` / `unsupported_claim_type` / `invalid_unknown` | support |
| `ai_data_insufficient` | `insufficient_data` | support |
| `ai_catalog_invalid` | `invalid_catalog` / `inconsistent_source` / `catalog_budget_exceeded` | catalog |

目录先于 LLM，失败则不调用 LLM。响应阶段仍保留 finish_reason=length、refusal、envelope、parsing、schema 的现有优先级；领域层按前述验证顺序，节点固定 risk -> attack -> observations 索引 -> recommendations 索引。缺少角色报 missing_support；存在但类型错误报 type_mismatch；额外正确类型引用不占合法角色报 unrelated_reference。低数据的肯定风险/攻击/聚合判断在类型通过后报 ai_data_insufficient。不得统一重包成 ai_evidence_invalid 丢失细分原因。

对 CRITICAL 和尚无支持规则的攻击类型，不定义伪证据角色：在引用存在检查后返回 unsupported_claim_type；若 dataSufficient/riskAssessable 不足则优先 ai_data_insufficient。Unknown 的空引用与 confidence 关系在支持阶段校验，使用 invalid_unknown。格式合法但任意的引用 ID 只在内存中查表，不回传其字符串。

本地目录错误使用 `LocalAnalysisFailure`（固定 `failureSource: "catalog"`、受控 errorCode、retryable=false 和诊断字段），`AIAnalysisResult.unavailable.failure` 扩展为该类型与现有 ExternalFailure 的判别联合。Pipeline 的日志投影据此省略 external_service，并使用 analysis_failed 事件；LLM 协议及引用失败继续走 llm 外部失败。不得为本地失败调用 `toExternalFailure(error, "llm")` 制造错误归属。AppError 的公共参数保持兼容，只有可选诊断扩展；GraphQL/WeCom 调用链不承受新枚举限制。

### 诊断信任边界

新增诊断仅 `validationStage`、`validationReason`、`validationPaths`、`issueCount`、`referenceCount`、`catalogEntryCount`，都由受控构造器产生。路径白名单如 `risk.level`、`attack.evidence_ids`、`observations[].evidence_ids`、`recommendations[].kind`、`root`；最多 10 个，每个 <= 64 ASCII 字符。未知键、动态键名、模型 ID、Zod issue message、expected/received、实体值及 raw Error/cause 不进入 DTO。数组索引用 `[]` 归一化；数量为有界非负整数（最大 65535，超出饱和）。不记录实际目录或所有引用 ID，即使其格式合法。

已有外部状态/耗时/token计数仍保留；finishReason 先映射 `stop|length|content_filter|tool_calls|function_call|unknown`，不保留任意 Provider 字符串。Logger 对诊断字段及 Error 分支再次白名单处理；不依赖通用 Secret 正则就能阻止恶意 path/ID 泄漏。保留既有 incident_id、correlation_id、窗口等关联上下文，新诊断绝不加入具体攻击实体。`ai_catalog_invalid` 为本地派生失败，externalService 可省略，不能误标为 Provider 返回坏数据。

实施时，Client 的成功响应诊断通过以结构化结果对象为键的短生命周期 WeakMap 传到 Analyzer。记录只含受控 finishReason、refusal 布尔值、耗时和数量，不含原文或 Prompt；不扩展模型 JSON 字段、不增加持久化存储。这样后续引用/支持失败仍保留实际 LLM 请求耗时和 token 计数，不误报为零耗时。

所有上述 AI 失败均不可重试并进入规则降级；没有 repair prompt 或第二次模型内容修复。仅原有 HTTP 429/5xx 可重试一次。采集成功时一次 collectSnapshot 实际为两次 GraphQL HTTP（聚合 + samples），不能把“一轮”误写成“一次 HTTP”。LLM 输出失败：GraphQL HTTP=2，LLM HTTP=1，WeCom HTTP=1（发送成功时），Statistics/Rules 各=1，Queue ack=1/retry=0。临时 LLM HTTP 后无效输出：LLM HTTP=2，其他不变。目录失败、空快照：LLM HTTP=0。通知自身临时失败只复用已生成消息重试，耗尽仍依现有契约 ack。

## 通知渲染与信任边界

风险/攻击标题和每条观察、建议通过模板穷举分派，值经同一 validated catalog 查找。保留域名、时间、固定窗口、数据截至、两种事件数、Top IP/Country/ASN/Path、Action、AI 摘要、Evidence、建议、Dashboard、身份标识；summary 由观察模板组合，空观察时显示风险/Unknown 的固定摘要。关键事实不依赖模型是否选择该条引用。

原始实体是数据而非指令。沿用企业微信 text 消息，不把 sample URL 变成可执行操作或作为 Dashboard；数据值用边界标识，CR/LF、控制字符、双向控制符可见转义，不让实体插入新标题或“已封禁”等伪指令。普通点号、中文、大小写和 query 完整保留。过长实体整项显示“值过长，已省略”及省略提示，不显示看似完整的前缀实体。凭证不得进入 Prompt/通知，现有运行时 Secret 不作为目录源。

长度控制采用完整行/条目预算，不截断半条支持结论。优先保留身份、窗口、事件数、风险/Unknown/降级、每维首项或明确省略标记、至少一条建议和已存在的 Dashboard；不足时先减少其他 Top 项、样本和额外观察。保留采样口径、规则等级不等于危害、Bot 自评非概率等与被显示条目绑定的限定语；不能为节省长度留下无条件结论。边界测试验证 UTF-8 字节与现有 maxLength 限制，保守发送上限 2000 bytes，maxLength 更小时同时满足。极端超长身份/域名沿用明确省略策略并标注，正常 fixture 必须完整显示。

## 兼容与恢复

1. 初始阶段仅创建 draft artifacts；用户已审计并授权实施，按 tasks TDD 一次覆盖全部模块，保留原统计/窗口测试。验收结果见 verification.md；主 Specs 同步和归档仍等待单独指示。
2. 代码内 `schema_version=2`、Catalog version=1；Prompt、Schema、Client、统一校验、Formatter、错误分类、fixtures 同一提交集切换，无双读/双校验开关。旧输出在 schema 阶段拒绝并降级，不转换自由文本为引用。
3. Queue 只保存告警/窗口，旧待处理消息由新 Consumer 正常分析，无存储数据迁移。运行中旧调用留在旧 Worker 版本内；不复用跨版本 AI 结果。至少一次投递的重复通知风险仍存在。
4. 更新 README、llm-model-compatibility、release-checklist、deployment-verification，记录 v2 验证样本、失败分类及本次并未验证真实 Provider。未来发布前先离线 Workers mock、类型/Lint/测试、Wrangler dry-run；真实非生产 Provider/机器人验证及任何部署须另获明确授权并确认环境隔离，不能直接假设已有 staging。
5. 获授权后的发布观察结构/引用/支持失败率、Unknown/规则降级比例、通知成功率与耗时，仅受控计数；不能以减少 Unknown 为由放宽验证。退化时整包回滚已知版本，Queue/Secrets/窗口无需迁移。回滚到旧版会恢复已知正则误报风险，必须明确记录；不自动切回旧版或双跑两套校验。
6. 主 Specs 目前为空，前序 MVP approved、optimize implemented 均未归档。将来按用户指示同步时，先确认前序完成状态再同步其基线；用本能力替换旧 Structured AI output / Evidence traceability / Advisory-only recommendations、Formatter 的模型字符串/截断子场景及旧 invalid evidence 诊断。保留前序 HTTP 重试、token、超时和降级约束，不让较早 Change 覆盖新契约。

## Risks / Trade-offs

- 有限语言减少模型表达价值：模型负责选择与排序，无法开放解释新攻击。以明确 Unknown 换取可审计边界；新增类型必须扩展规则表和反例测试。
- 聚合维度不可任意联结：Top IP 与 Top Path 同时存在不证明同一批请求来自该 IP 且命中该 Path。只有 sample 可展示单条事件字段关系，也不能外推总体。
- Bot 规则只能验证“具备指定启发式特征”，不能证明恶意自动化；合法客户端也可能同 UA、高速率。模板必须保留“疑似”和人工核验。
- 风险规则为运维关注等级，不是模型推断正确性证明。HIGH/LOW 都不能证明攻击成立或系统安全；CRITICAL 及其他攻击类型在当前能力下拒绝。
- 目录上限可能隐藏低排名事实：记录受控遗漏计数，保留原通知事实，支持链不完整则 Unknown/降级，不能以字符串近似替代。
- GitNexus 是依赖线索，不覆盖 TypeScript 所有类型关系。实施前必须核对公共 Schema、Client、Formatter 与测试消费者，不能只依据风险评分。

## 测试计划

| 验收组 | 正例与反例 |
| --- | --- |
| Catalog | 同输入重复/时钟变化 ID 稳定、重复 ID 拒绝、各维 10/11、samples 10/11、100 项/128 KiB、2048/2049 bytes、空值/null、未知 Finding、依赖被省略、输入一致性 |
| Schema | v2 完整响应、旧字段/任意扩展/嵌套自由文本拒绝、枚举/范围/数组/长度边界、Provider Schema 与 wire Zod 同源 |
| 引用 | 存在/不存在、格式非法、重复、跨条复用、错误类型、多余引用、缺角色、跨目录不复用 |
| 支持策略 | 表中每一行的通过/拒绝，真实 path+无关结论、错误 Finding/stat 配对、低等级冒充高风险、遗漏高风险引用、样本冒充总体、跨聚合错误联结 |
| Unknown | 空引用唯一例外、非 Unknown 无证据、全 unknown Findings、total=0、partial Statistics、Unknown confidence 非零拒绝；0/9/10 UA 样本门槛 |
| 展示 | `/index.php`、`WAF/API`、`ExampleClient/1.0`、完整 URL、`/用户/登录?Next=%2FHome&Mode=A`，不截路径/不去 query/不改大小写；换行/Markdown/控制符/注入样本值按数据展示 |
| 降级/日志 | 每类 code/reason；恶意引用 ID、扩展字段名、Provider finish_reason、Prompt、原文、实体、Credential 哨兵均不进日志或失败通知；目录错误不标 Provider 错误 |
| Workers 全链路 | 上述 HTTP 调用次数、统计/规则一次、固定窗口完全相同、ack/retry；LLM 429/5xx 原重试；WeCom 重试内容一致、成功后 logger 抛错仍 ack |
| 完整性 | required 通知字段、最坏 UTF-8 长度、整条结论裁剪保留限定语；原有 webhook/Queue/GraphQL/空数据测试不回归 |

每个实现任务先新增失败断言并运行确认 RED，再最小实现至 GREEN。所有测试使用仓库现有 Workers Vitest 插件和虚构数据，不调用真实 Provider/机器人。最终 typecheck、lint、test、OpenSpec、工作流校验、GitNexus 检查及 Credential 扫描；bindings 若实际发生经批准变更另跑 types。
