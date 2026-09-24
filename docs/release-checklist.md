# 单环境发布检查清单

本清单不授权远端操作。资源创建、Secret 写入和部署必须获得用户明确授权。

## 资源与配置

- [ ] Worker 名称为 `cloudflare-ai-alert-analyzer`。
- [ ] Queue 名称为 `cloudflare-ai-alert-analyzer`，consumer 使用 `max_batch_size = 1`。
- [ ] `CLOUDFLARE_API_TOKEN` 以 Secret 保存，权限和 Zone 范围最小化。
- [ ] `LLM_API_KEY` 以 Secret 保存，并配置中转站费用与速率限制。
- [ ] `WECOM_WEBHOOK_URL` 以 Secret 保存，目标群已确认。
- [ ] `LLM_BASE_URL` 以 Text 保存，值为中转站 `/v1` 基础地址。
- [ ] `LLM_MODEL` 以 Text 保存，值为中转站支持的模型标识。
- [ ] `BUSINESS_CONFIG.llmTimeoutMs` 未配置时默认为 `30000` 毫秒；显式值位于 `1000` 至 `120000`，且只影响 LLM。
- [ ] `BUSINESS_CONFIG.llmMaxOutputTokens` 未配置时默认为 `2048`；显式值位于 `512` 至 `8192`，且为整数。
- [ ] Cloudflare GraphQL 和企业微信继续使用 `requestTimeoutMs`，未被 LLM 超时覆盖。
- [ ] 模型已通过脱敏 `/models` 兼容性验证；Worker 仅使用 `LLM_MODEL`，未硬编码或自动切换模型。
- [ ] Dashboard 和仓库中不存在第二套 staging/production 配置。

## 质量门禁

- [ ] `npm ci` 成功。
- [ ] `npm run types` 成功且 bindings 与 `wrangler.jsonc` 一致。
- [ ] `npm run typecheck` 成功。
- [ ] `npm run lint` 成功。
- [ ] `npm test` 全部通过。
- [ ] `npx wrangler deploy --dry-run --keep-vars` 成功。
- [ ] OpenSpec 严格校验和工作流校验成功。
- [ ] Credential 扫描未发现真实 Secret。

## 发布审批

- [ ] Catalog v1 与 AI v2 的 Prompt、Schema、引用支持校验、Formatter、诊断作为同一版本发布，旧响应拒绝、旧实体扫描已删除。
- [ ] 已用非生产凭证确认实际 Provider 支持 v2 JSON Schema；本地 mock 测试不能替代此项。
- [ ] 已确认实际环境隔离条件；当前单环境实现不等于已具备 staging，本变更不自动新增环境或资源。
- [ ] 已说明 Unknown、规则关注等级及疑似 Bot 的边界；置信度不作为攻击概率。
- [ ] 回滚版本整体恢复，不双跑新旧契约；回滚旧版的正则误报风险已记录。

- [ ] 发布版本、变更范围、回滚版本和操作人已记录。
- [ ] Queue 至少一次语义和极端重复通知风险已说明。
- [ ] 公网 Webhook 无入站鉴权的风险已接受并配置流量观测。
- [ ] 远端资源创建已获得明确授权。
- [ ] Secret 写入已获得明确授权。
- [ ] Worker 部署已获得明确授权。

## 发布后验证

- [ ] Webhook Route 响应符合 `404`、`405`、`400`、`413`、`202` 和入队失败语义。
- [ ] Queue producer/consumer bindings 正常，窗口在重试时不漂移。
- [ ] Cloudflare GraphQL、LLM 中转站和企业微信状态可通过脱敏日志观测。
- [ ] LLM 故障不会丢失告警或触发 GraphQL 重查。
- [ ] 企业微信最终失败被记录并确认，不触发整链 Queue 重放。
- [ ] 通知包含 `incident_id`、`correlation_id` 和固定分析窗口。

## 停止与回滚条件

出现 Credential 泄漏、窗口漂移、统计分母错误、AI 编造关键事实、通知重复风暴或只读边界被突破时，立即停止发布或回滚上一已验证版本。保留脱敏日志和事件身份标识，修复后重新执行端到端验证。
