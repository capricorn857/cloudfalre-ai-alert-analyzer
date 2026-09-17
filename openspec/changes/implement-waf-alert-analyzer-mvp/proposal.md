---
status: approved
---

# 变更提案：实现 Cloudflare WAF 告警分析 MVP

## 背景

Cloudflare 现有 WAF 告警只能说明异常已经发生，运维和安全人员仍需手工进入 Dashboard 还原攻击来源、目标、防护效果和风险。项目需要在 Cloudflare Workers 上建立一条只读、可降级、可追溯的自动分析链路，把有效告警转换为可直接用于初步研判的企业微信通知。

## 目标

- 初始化基于 TypeScript、Cloudflare Workers、Cloudflare Queues、Zod、Wrangler、Vitest 和 ESLint 的 MVP 工程。
- 提供公开接收、经过 Schema 校验和告警类型过滤的 Cloudflare WAF Webhook，并将内部 Alert 延迟写入 Queue 后返回 `202 Accepted`。
- 在入队时按照 `query_started_at = webhook_received_at + settle_seconds` 固定逻辑查询时间和 `analysis_window`；Queue Consumer 另行记录仅用于观测的 `processing_started_at`，所有重试复用同一快照窗口。
- 查询 Cloudflare GraphQL Security Analytics，标准化 Incident，并由程序计算 Statistics 和确定性 Findings。
- 调用兼容 OpenAI HTTP 接口生成结构化 AI 分析；调用失败或输出无效时降级为规则分析。
- 格式化并发送企业微信通知，展示分析窗口、事实、结论、建议、`incident_id` 和 `correlation_id`。
- 增加有限重试、错误分类、结构化脱敏日志、Workers Runtime 测试和单环境端到端验收流程。
- 准备单套 Worker/Queue 的发布检查清单和人工门禁，但不创建远端资源、不写入真实 Secret，也不执行部署。

## 非目标

- 不建设 Web 管理后台、权限系统、历史检索、持续事件跟踪或初报/终报机制。
- 不自动封禁 IP，不修改 WAF、Rate Limit 或其他 Cloudflare 配置。
- 不引入数据库、D1、KV、Durable Objects、R2、Workflows、第三方队列、容器或自建服务器。
- 不在本 Change 中创建远端资源、写入真实 Secret 或执行远端部署。

## Capabilities

### New Capabilities

- `cloudflare-alert-ingestion`: Webhook 路由、Payload 校验、WAF 告警过滤与映射、固定窗口消息构造和 Queue 入队。
- `waf-snapshot-analysis`: Queue 消费、固定窗口 GraphQL 数据采集、Incident 标准化、统计和确定性规则分析。
- `ai-assisted-analysis`: 受 Evidence 约束的结构化 AI 分析，以及 LLM 不可用时的规则降级。
- `wecom-alert-notification`: 使用已校验领域数据生成固定格式通知，并可靠发送到企业微信机器人。
- `worker-operations`: 配置校验、错误分类、有限重试、日志脱敏、单环境配置和部署验证要求。

### Modified Capabilities

无。

## 影响范围

- 新增 `src/` 与 `test/` 下的 Worker 应用、领域模块、外部客户端、分析逻辑和测试夹具。
- 新增 npm 工具链、单 Worker/Queue 及 Queue producer/consumer bindings 配置。
- 新增对 Cloudflare GraphQL、兼容 OpenAI 的 LLM API 和企业微信 Webhook 的出站请求。
- 需要三项 Workers Secrets：`CLOUDFLARE_API_TOKEN`、`LLM_API_KEY`、`WECOM_WEBHOOK_URL`；MVP 不配置入站 Webhook Secret。
- 未鉴权的公网 Webhook 存在伪造请求和 Queue 滥用风险，MVP 通过严格 Payload 校验、受支持告警类型过滤、请求体大小限制和平台侧流量观测降低风险。
- MVP 不引入数据库、持久化幂等、DLQ、Workflows、自建服务器或自动 Cloudflare 配置变更。

## 风险与兼容性

- Cloudflare Queue 为至少一次投递，极端情况下可能重复通知；MVP 通过稳定的 `incident_id` 和 `correlation_id` 支持人工识别，不承诺 exactly-once。
- Security Analytics 可能存在采样或聚合延迟；系统固定延迟后只执行一次快照，并展示分析窗口与统计口径。
- 公网 Webhook 在 MVP 不配置入站 Secret；通过严格 Schema、请求体限制、类型过滤和平台流量观测降低滥用风险。
- 首次实现没有历史应用数据迁移；Queue Message 使用显式版本，未来破坏性变更需保持 Consumer 兼容。
- 单环境配置降低部署复杂度，但不提供 staging 隔离；所有远端变更必须依赖发布前检查、人工授权和可回滚版本控制。

## 验收标准

- 有效 WAF Payload 成功固定窗口并入队后返回 `202`；无效 Payload 和入队失败不得返回成功。
- Consumer 的首次处理与技术重试使用完全相同的 `analysis_window`，且每次正常消费只进行一轮业务快照采集。
- Top IP、Path、Country、ASN 和 Action 比例使用 GraphQL `total_events`，可用相同窗口在 Dashboard 核验或解释差异。
- AI 结果通过结构与 Evidence 校验；LLM 失败时仍发送包含 Statistics 和 Findings 的降级通知。
- 企业微信通知展示窗口、身份标识、事实、结论和建议，发送成功后不得由应用主动触发 Queue 重试。
- `npm run types`、`npm run typecheck`、`npm run lint`、`npm test`、OpenSpec 严格校验与 Credential 扫描通过。
