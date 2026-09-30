## Purpose

以现有快照领域输入生成有界且可追溯的结构化证据，通过逐条引用、受控结论、明确支持条件和程序模板生成通知，替代自然语言实体扫描，并在失败时保持告警降级、诊断脱敏与固定窗口处理语义。

## ADDED Requirements

### Requirement: Bounded derived evidence catalog

系统 MUST 仅从已校验 Incident、Statistics、Findings 派生目录；每项 MUST 有唯一局部 ID、固定类型、来源、口径与结构化值。相同输入和版本 MUST 产生相同目录与 ID，不依赖随机数或处理时间。目录 MUST 保持原始实体含义，不去 query、改变大小写、前缀匹配、解析自然语言或让模型重算统计。

目录 SHALL 至多 100 项：context/quality/total 各 1 项，七个聚合维度各 10 项，九项已有统计，八类 Finding，10 条样本；UTF-8 JSON 至多 128 KiB，单业务字符串至多 2048 bytes。超长业务值整项省略，依赖被省略则省略对应 Finding，记录固定类别数量。必需上下文超限、源数据不一致或最终总预算超限 MUST 规则降级而非改写实体。

#### Scenario: Stable identifiers
- **WHEN** 相同输入在不同处理时间重复生成目录
- **THEN** 条目顺序、ID、值完全相同，ID 不包含实体值，不保证不同输入或数组重排的 ID 不变

#### Scenario: Catalog bounds and dependency closure
- **WHEN** 聚合或样本超过 10 项，或统计的实体超出字符串限额
- **THEN** 保留原顺序前 10 个候选中的合规整项，使用原位置 ID，累计省略数量且不留下悬空 Finding 引用

#### Scenario: Empty or inconsistent data
- **WHEN** totalEvents 为零、统计为 null 或源输入不一致
- **THEN** null 不伪造为零；空快照直接基础通知；不一致目录按 ai_catalog_invalid 降级且不调用 LLM

### Requirement: Explicit aggregate and sample scope

系统 MUST 区分固定窗口 GraphQL 聚合与样本。总体比例 SHALL 仅基于已有总体 Statistics 或通知中现有 count/totalEvents 展示算法。UA 比例 MUST 标明分母为非空 UA 样本数；裁剪给模型的 sample 列表 MUST NOT 改变原统计分母。聚合 Top 维度 MUST NOT 被联结成未观察到的单条请求关系。

#### Scenario: Sample cannot prove population share
- **WHEN** 模型用真实 sample 或 stat_ua 引用支持总体集中度或总体 Action 比例
- **THEN** 引用类型校验失败，整体 AI 结果降级

#### Scenario: Marginal dimensions are not joint evidence
- **WHEN** 某 IP 与某路径分别出现在 Top 列表
- **THEN** 模板不声称该 IP 请求了该路径，只有单条 sample 的字段可作为该事件联合事实

### Requirement: Closed structured output

模型输出 MUST 使用 schema_version=2，risk、attack、observations、recommendations 都采用封闭对象和受控类型。risk/attack 及每条 observation/recommendation MUST 各自绑定 evidence_ids；每节点 0..4，观察 0..6，建议 1..3，总引用数最多 44。节点内重复 ID、重复观察及重复建议类型 MUST 拒绝；跨节点重复使用同一证据 SHALL 允许。

输出 MUST NOT 包含自由文本、实体、统计值、summary、rationale 或不受约束的参数。所有额外字段 MUST 拒绝而非静默删除。confidence SHALL 为 0..1 且只属于 attack；Provider JSON Schema 与本地结构约束 MUST 同源一致。目录依赖语义验证是额外强制门禁，不得声称仅靠 JSON Schema 完成。

#### Scenario: Valid typed output
- **WHEN** 模型返回合法 v2 对象且每条声明满足引用和支持策略
- **THEN** 系统仅向通知传递绑定同一目录的已验证结果

#### Scenario: Free text cannot bypass templates
- **WHEN** 模型在根对象、观察或建议中添加 IP、路径、数字、summary、text 或其他自由字段
- **THEN** 结构失败，任何附加文本不得进入通知或日志

#### Scenario: Provider contract parity
- **WHEN** 构造结构化输出请求
- **THEN** Provider 和本地结构契约具有相同 required、额外字段禁止、枚举、字符串、数组和数值限制，本地继续验证所有跨字段语义

### Requirement: Reference existence and deterministic support

系统 MUST 依次验证结构、重复、引用存在、类型与角色、数据充分性和支持条件。每条引用 MUST 对应允许角色，额外无关引用、缺少必要证据或条件不满足 MUST 拒绝整个分析，不自动修复或部分接受。

集中度观察 SHALL 使用相同维度的 stat + medium/high Finding + total；allow/block 观察亦如此；challenge 仅使用已有 stat + total 报事实，不声称异常；速率使用 stat + medium/high Finding + context；UA 集中度使用 sample stat + UA Finding，仅报告样本；单样本观察只引用恰好一条 sample。Finding 的 value MUST 等于关联统计且达到其已有 threshold，不得解析 Finding 文本获取证据。

#### Scenario: Unknown or duplicate reference
- **WHEN** 引用不存在或节点内包含重复 ID
- **THEN** 分别返回 reference_not_found 或 duplicate_reference，诊断不携带该 ID

#### Scenario: Real but irrelevant evidence
- **WHEN** Path 结论引用真实 IP 统计、缺对应 Finding、引用不匹配的 Finding，或添加真实但无关证据
- **THEN** 分别按类型不匹配、缺支持或支持关系不成立拒绝，不因“ID 存在”放行

#### Scenario: Supported observation
- **WHEN** path stat 为 60%，path Finding 为 high/value=60/threshold=50，且同一目录总数可用
- **THEN** 允许程序模板报告该路径集中度达阈值，不宣称路径恶意或与独立 Top IP 关联

### Requirement: Controlled risk and attack assessments

风险 SHALL 表示规则关注等级。riskAssessable MUST 要求 dataSufficient、统计/Finding 投影完整、四项聚合集中特征和 allow/block/challenge/rate 非 null，且非空 Findings 不能全 unknown。HIGH/MEDIUM MUST 引用 quality、风险 Finding 及对应 stat，且等级等于整个目录风险集合（ip/path/country/asn/allow/request_rate）的最高级。LOW MUST 引用 quality+total 且该集合为空，不得表示系统安全。CRITICAL 在当前数据能力下 MUST 拒绝。

Bot SHALL 仅作为假设：必须引用 sample UA stat/high Finding 和 aggregate rate stat/high Finding，riskAssessable=true、dataSufficient=true、非空 UA 样本数至少 10，自评置信度 >0 且 <=0.6。其他非 Unknown 攻击类型在当前契约下 MUST 拒绝，不得仅以 IP、登录路径或总体集中度证明暴力破解、凭证填充、扫描、漏洞利用或 API Abuse。

#### Scenario: Cherry-picked risk
- **WHEN** 模型引用 medium Finding 试图给出 MEDIUM，但完整目录风险集合含 high
- **THEN** 支持条件失败并降级；模型不能靠挑选引用隐藏更高规则关注等级

#### Scenario: Bot hypothesis boundary
- **WHEN** 两个 high Finding、对应统计和至少 10 个非空 UA 样本均满足且 confidence=0.6
- **THEN** 可展示“疑似自动化特征（Bot，待人工核验）”及“模型自评，非概率”；9 个样本、缺任何角色或 confidence>0.6 必须拒绝

#### Scenario: Unsupported specific attack
- **WHEN** 模型引用真实 /login 证据返回 Brute Force 或输出 CRITICAL
- **THEN** 返回 unsupported_claim_type，不把实体存在当作攻击/业务危害证明

### Requirement: Unknown and insufficient evidence

risk.Unknown、attack.Unknown 和 insufficient_data/none 观察 MUST 恰好空引用；attack.Unknown confidence MUST 为 0。其他类型 MUST NOT 使用空引用。Unknown SHALL 在数据充分时也允许保守弃权。数据不足时，肯定风险、具体攻击和需要总体数据的观察 MUST 拒绝；样本观察与人工核验建议可以保留其明确有限语义。零事件快照 SHALL 沿用不调用 LLM 的现有流程。

#### Scenario: Valid abstention
- **WHEN** risk/attack 返回 Unknown、各空引用，attack confidence=0
- **THEN** 显示程序生成的未作判断说明，不视为系统安全或不存在攻击

#### Scenario: Definitive result with insufficient data
- **WHEN** dataSufficient=false 或 riskAssessable=false 却给出 HIGH 或具体攻击判断
- **THEN** 合法引用及类型通过后仍返回 ai_data_insufficient，并执行规则降级

#### Scenario: Invalid Unknown reference
- **WHEN** Unknown 携带引用、非零 attack confidence，或正常结论空引用
- **THEN** 按 invalid_unknown 或 missing_support 拒绝，不把 Unknown 作为通用逃生通道

### Requirement: Controlled advisory recommendations

建议 MUST 限于 review_source（单个非零聚合 IP/Country/ASN）、review_target（单个非零聚合 Path/Host）、review_waf（allow stat + medium/high Finding + total）、verify_sample（单个 sample 或有效 sample UA stat）、manual_dashboard（context）。所有建议 MUST 由程序模板表达人工核验，不生成配置或已执行动作。模型 MUST NOT 提供任意文案、URL 或 Cloudflare 操作参数。

#### Scenario: Read-only supported advice
- **WHEN** 建议引用合规目标路径或 allow 高比例证据
- **THEN** 通知分别建议人工核验业务日志或现有 WAF 处理情况，不声称本系统封禁或修改了任何配置

#### Scenario: Advice without required evidence
- **WHEN** review_waf 只引用真实路径，或 manual_dashboard 没有 context
- **THEN** 类型不匹配或缺支持失败，不能以“只是建议”为由放行

### Requirement: Program-rendered notification

通知 MUST 从已验证同一目录和原 snapshot 读取事实，按受控模板展示总结、逐条依据和建议；MUST 保留原通知关键内容，包括身份、域名、时间、固定窗口、数据截至、两种事件数、Top 四维、Action、风险/降级、摘要、Evidence、建议及已存在的 Dashboard。

普通点号路径、URL、UA、中文、查询参数、大小写 MUST 保持原义。控制字符 MUST 可见转义；超长值整项省略并标注，不产生似是而非的截断实体。长度裁剪 MUST 保留整条结论的口径和限定语，不能把“疑似”裁成肯定判断。模型原文及无法验证的开放语义 MUST NOT 展示。

#### Scenario: Punctuation and multilingual entities
- **WHEN** 原证据包含 /index.php、WAF/API、ExampleClient/1.0、完整 URL 或 /用户/登录?Next=%2FHome&Mode=A
- **THEN** Formatter 按证据原值展示，不从这些值提取新的 /index、/API 或 /1 实体

#### Scenario: Data masquerading as instructions
- **WHEN** sample 字段包含换行、控制符或“已封禁”字样
- **THEN** 以有边界的数据值呈现并转义控制符，不作为系统结论或执行结果

#### Scenario: Bounded message
- **WHEN** 通知接近长度上限
- **THEN** 按完整条目减少低优先级内容，保留身份/窗口/状态及被展示判断的限定语，明确省略而非切断实体

### Requirement: Safe stable failure diagnostics

结构错误 MUST 区分 llm_output_not_json/llm_output_schema_invalid；引用错误 MUST 使用 ai_reference_invalid；类型错误 ai_reference_type_mismatch；缺支持/条件失败 ai_claim_unsupported；数据不足确定判断 ai_data_insufficient；目录错误 ai_catalog_invalid。上述错误 MUST 不可重试并使用设计中的固定原因枚举。

新诊断 SHALL 仅含受控字段路径、阶段/原因枚举和有界计数。最多 10 个白名单路径、每条最多 64 ASCII 字符、数组索引归一为 []，未知键归 root，计数至多 65535。MUST NOT 记录 Prompt、模型原文、实际实体、模型引用字符串、任意 Provider finish_reason、Credential 或原始 Zod issue/error。既有状态、关联字段与耗时可保留，不将目录错误误归为 Provider 响应错误。

#### Scenario: Malicious diagnostics input
- **WHEN** 引用、未知字段名、finish_reason 或嵌套 Error 含敏感哨兵
- **THEN** 日志仅出现固定路径/原因/计数，所有哨兵均不出现

#### Scenario: Distinct supported failure classes
- **WHEN** 分别发生不存在 ID、错误证据类型、缺少支持、数据不足确定结论
- **THEN** 日志稳定区分四种错误，不统一包装为旧 ai_evidence_invalid/unsupported_entity

### Requirement: Failure isolation and atomic contract migration

目录、LLM、结构或引用失败 MUST 使用原 Statistics/Findings 发送规则降级；MUST NOT 重查 GraphQL、移动固定窗口、重算统计、修复性重试模型或重放 Queue。只保留现有 LLM HTTP 429/5xx 一次内部重试与企微独立重试。发送成功后日志失败 MUST NOT 引发 Queue retry。

新 Prompt、Schema、校验、模板、诊断 MUST 同版本切换；旧自由文本输出 MUST 拒绝，旧实体及自动动作自然语言正则 MUST 删除，不能同时启用新旧机制。Queue Message 保持兼容。回滚 SHALL 整包回滚并注明旧误报风险，不授权本任务进行任何远端变更。

#### Scenario: Output validation fallback counts
- **WHEN** 一次正常快照采集后模型输出校验失败且通知成功
- **THEN** collectSnapshot=1，GraphQL HTTP=2（聚合+样本），LLM HTTP=1，Statistics/Rules 各=1，企微 HTTP=1，Queue ack=1/retry=0，窗口保持原值

#### Scenario: LLM transient retry then invalid output
- **WHEN** 第一次 LLM HTTP=429，第二次返回引用错误
- **THEN** LLM HTTP=2，其余调用次数与普通输出失败相同，仍发送规则降级

#### Scenario: Catalog error or empty snapshot
- **WHEN** 目录生成失败或零事件快照
- **THEN** LLM HTTP=0，通知继续，无额外采集或 Queue retry

#### Scenario: Legacy output rejected
- **WHEN** v2 Worker 收到旧 risk_level/summary/evidence 自由文本响应
- **THEN** 结构失败并降级，不尝试正则提取实体或转换为新引用
