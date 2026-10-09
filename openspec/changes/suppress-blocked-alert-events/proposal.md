---
status: implemented
---

# 变更提案：已拦截事件静默

## 背景

现有 master（483eaa5）已实现多 Host 快照分析，但发现 Top Host 时包含 block，且 `processHostAlert` 总是进入通知阶段。已拦截的大量事件占据分析名额并产生噪声。现有代码状态优先于 AGENTS.md 中历史初始化描述。

## Why

用户已确认：不区分自定义/托管规则，不核验黑名单，精确 `action === "block"` 的事件不再进入 AI 或企微明细；首次被拦截攻击及可能误拦截也接受静默。非 block 并不证明攻击成功或请求到达源站。

## 目标

在同一 Queue 固定窗口内，先过滤再发现 Host；让统计、样本、Findings、Evidence、通知共用待关注范围；仅在有效全Zone固定窗口查询、raw>0、attention=0、直接blocked=raw、topHosts为空且无已知矛盾时静默并ack。策略固定为exclude-exact-block-v1，reason为no_attention_events_observed，observationBasis为adaptive_aggregate并携带采样风险说明。

## What Changes

- **BREAKING（业务通知行为）**：有效且内部一致的全Zone过滤聚合零快照跳过 LLM、Formatter 和企微，返回独立 `suppressed` 业务结果，不再“一律分析后发送”。
- 查询侧保留非 block、未知及无法判定 Action；禁止按 IP、Host、规则来源整体排除。
- 区分原始总量、待关注总量和完整原始Action分布直接取得的 block 计数；采样估计不可简单相减为精确数量。
- 原始空窗口保留数据不足通知；过滤失败、协议不完整和已知聚合矛盾均保守降级；Adaptive采样或采样状态未知本身不阻止静默。
- 显式修改已选 Host 展示范围、统计分母和通知契约；维持证据验证、字节预算及阶段内重试。

## 非目标

不改防护配置，不自动封禁，不引入存储/新 SDK/队列，不轮询或移动窗口；规划阶段不写生产代码、测试代码；用户已于2026-10-09明确批准实施，现允许按tasks编写实现与测试，仍不提交、合并、同步主 Specs、归档或部署，不调用真实 LLM/企微。

## Capabilities

### New Capabilities

- `blocked-event-suppression`：严格过滤、可信静默决策、异常降级、策略兼容及可观测结果。

### Modified Capabilities

- `host-scoped-alert-analysis`：发现前过滤、同范围采集和证据、通知 Host 展示边界、预算。
- `waf-snapshot-analysis`：原始与待关注计数区分和统计契约。
- `wecom-alert-notification`：正常发送例外、过滤后通知、原始空窗口与失败消息。

`openspec list --specs` 实际返回 No specs found；上述既有能力来自已确认但尚未同步的 `implement-waf-alert-analyzer-mvp` 和 `host-scoped-alert-analysis` Change，沿用原路径及 requirement 名称写 MODIFIED delta，不冒充新能力。后续同步需先经授权建立前序主 Specs，再应用本 delta；本次不擅自同步或改前序 Change。

## 影响范围

涉及 GraphQL client/响应 Schema、Host 领域契约、Analyzer、统计/规则/证据、AI 输入、Formatter、Pipeline 和日志；公共符号详见 design。Webhook 路由、外部 Payload、Queue 消息结构及 bindings 不变。新增纯函数静默判定，无外部依赖或 Cloudflare 资源变化。

## Impact

现有“全快照统计”“分析后发送通知”“所有选中 Host 必须展示”分别改为“待关注范围统计”“可信静默例外”“过滤后选中 Host 在非静默通知中必须展示”。修改点在 delta specs 明列；未涉及的安全、AI 支持门槛与重试规范继续有效。

## 风险与兼容性

- 目标两dataset字段/settings、精确字符串语义及最终四alias形状已有只读证据；底层null否定保留未证实、非空混合样本实测尚无。通过原始Action分布守卫及Mock对抗验证实现无法可靠保留则降级，不声称采样完整覆盖。
- 用户于2026-10-09选择观察策略：有效且内部一致的全Zone固定窗口过滤聚合零可静默，即使Adaptive采样没有完整性保证；接受稀少非block事件可能被漏掉。计数相等只是一致性检查，不是统计完整性证明。
- 不新增策略配置或 Queue 字段；新 Consumer 对新旧合法 v1 消息执行固定策略 `exclude-exact-block-v1`。整包回滚恢复旧通知行为，可能再次出现 block 明细/重复通知，不能承诺跨版本策略快照或 exactly-once。
- GitNexus已强制刷新并完成检测，跨模块总体CRITICAL；影响在批准的采集/分析/证据/通知/Pipeline范围内，已结合源码调用方、410项Workers测试及独立审阅复核。

## 验收标准

1. 自定义/托管 block 均被逐事件过滤；同 IP 的其他 Action、未知/缺失 Action 保留；大小写或空白变体不得被偷偷归为 block。
2. 全Zone聚合观察零且通过协议与一致性门槛：LLM/企微调用均为 0、ack=1、retry=0，日志异常仍不重放；无 `notification_sent`。
3. 混合事件只分析剩余范围；原 Top Host 都 block 时其他非 block Host 可进入名额；样本、统计和引用分母一致。
4. 查询失败、无效/缺失响应、聚合不一致、过滤能力不足均不得静默；采样或未知采样状态本身不触发通知；不能用样本全 block、Top N 或显示 100.0% 判定。
5. 原始空窗口发送明确数据不足通知，与 `no_attention_events_observed` 和失败结果可区分。
6. 窗口、Queue 至少一次投递、AI 局部降级、证据支持与归属、通知 2000 UTF-8 bytes、企微同文本有限重试及发送后不重放保持。
7. 后续实施先补失败测试再实现，Workers 集成测试、typecheck、lint、test、适用图分析及 OpenSpec 校验通过后才可请求验收；实现与离线验证完成，仍未部署、提交、合并或归档。

## 批准记录

2026-10-09，用户明确回复“方案已审核，可以实施”，批准当前设计、delta specs和tasks，后于同日明确接受Adaptive聚合观察零策略及漏掉稀少非block事件的风险，覆盖此前保守采样静默门槛。进入实施阶段，Action语义和目标预算门禁仍需完成；GitNexus门禁已有记录，不包含部署或资源变更授权。

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
