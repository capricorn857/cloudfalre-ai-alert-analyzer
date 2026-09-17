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
