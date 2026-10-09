## MODIFIED Requirements

### Requirement: Cloudflare GraphQL result contract
系统 MUST 用Zod校验固定窗口原始上下文、过滤待关注总量、有限Top Host及各Host总量/四维Top/Action/Source/有界样本。样本默认50且不超sample_limit，只保留datetime/action/clientIP/clientCountryName/clientAsn/clientRequestHTTPHost/clientRequestPath/source/userAgent等允许字段。所有Host明细与统计范围 MUST 排除严格block；原始rawActions仅用于决策/质量上下文。HTTP200也 MUST 检查errors，关键字段无效/缺失/部分错误数据不能作成功零。

跨独立alias的合法正数估计差异 MUST 保留为质量标记，不以相等为响应有效性条件。未知Action缺失值可在允许边界显式标准化不可判定，不能误当block；unsafe和/非法计数仍失败。直接blockedTotalEvents完整性基于Action分布结构和可判定性，不再要求与rawTotal相等，不得以独立估计相减取得。

#### Scenario: Valid estimates with a difference
- **WHEN** rawTotal1360而完整block分组1362，所有响应字段合法
- **THEN** 保留两者及差异标记供确定性判定，不拒绝整条响应或把block数置null

#### Scenario: Invalid GraphQL response
- **WHEN** HTTP200带errors、关键alias缺失、null数据或非法计数
- **THEN** 操作失败，不把失败当零，不把同一操作的部分data传给分析

### Requirement: Incident normalization
非静默系统 MUST 将已校验数据转换为统一命名、UTC、无Credential的Incident，包含事件身份/Provider/类型/资源/固定窗口/Payload参考数、Host事实、Statistics/Findings/Evidence及质量。静默 MUST 返回独立suppressed结果而非伪空Incident。rawTotalEvents、attentionTotalEvents（内部zoneTotalEvents）、直接block估计 MUST 区分，policyId/eventScope与质量显式携带；原始Zone上下文不得成为Host攻击证据。部分可用Host MUST 保留Incident，不能仅因原始上下文差异变为无Incident基础异常。

#### Scenario: Partial discovery quality
- **WHEN** 过滤Host可靠而原始计数不一致或未知范围未覆盖
- **THEN** Incident包含可靠Host和受控质量/比例不可用原因，采样估计不伪装精确数量

### Requirement: Deterministic statistics
系统 MUST 程序计算每Host过滤总量、Top IP/Path/Country/ASN集中度和Action比例、样本UA集中度及固定窗口速率，LLM不重算。Host分母用hostTotalEvents，Zone占比和覆盖用过滤zoneTotalEvents，raw/Payload只参考。相关比例不可比较 MUST null；可靠原计数不强行归一/补齐，不从独立采样估计相减出精确已过滤量。Host发现与细查差异不丢掉内部一致统计；Action/Source完整性和证据支持门槛保持。

#### Scenario: Independent positive count difference
- **WHEN** 原始上下文与过滤计数存在独立估计差异且Host内部一致
- **THEN** 保留Host事实及同范围统计；只将受影响的Zone占比/覆盖置null，不整体丢明细

#### Scenario: Unknown denominator
- **WHEN** Zone总量零伴随Host正，或Host内分母不可用
- **THEN** 相关比例null而非0/NaN/Infinity/伪百分比，通知展示未知

