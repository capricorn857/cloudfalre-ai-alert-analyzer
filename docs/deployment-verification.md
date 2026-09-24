# 单环境部署验证手册

本项目使用一套 Cloudflare Worker、Queue 和运行时配置：

- Worker：`cloudflare-ai-alert-analyzer`
- Queue：`cloudflare-ai-alert-analyzer`

本文不授权远端部署、Secret 写入或 Cloudflare 资源创建；执行这些操作前仍需用户明确授权。

## Dashboard 运行时配置

进入 Cloudflare Dashboard：

```text
Workers & Pages
-> cloudflare-ai-alert-analyzer
-> Settings
-> Variables and Secrets
```

添加三个 `Secret`：

```text
CLOUDFLARE_API_TOKEN
LLM_API_KEY
WECOM_WEBHOOK_URL
```

添加两个普通 `Text` 变量：

```text
LLM_BASE_URL
LLM_MODEL
```

`LLM_BASE_URL` 填 OpenAI 兼容中转站的 `/v1` 基础地址，不包含 `/chat/completions`。例如中转站请求地址为 `https://relay.example.invalid/v1/chat/completions` 时，变量值应为 `https://relay.example.invalid/v1`。`LLM_MODEL` 必须使用中转站支持的模型标识。

`BUSINESS_CONFIG.llmTimeoutMs` 由 `wrangler.jsonc` 管理，只控制 LLM 单次调用超时。未配置时默认 `30000` 毫秒；显式配置时必须是 `1000` 至 `120000` 范围内的整数并覆盖默认值。`BUSINESS_CONFIG.llmMaxOutputTokens` 默认 `2048`，显式配置必须是 `512` 至 `8192` 的整数。`requestTimeoutMs` 继续控制 Cloudflare GraphQL 和企业微信请求。LLM 429/5xx 最多内部重试一次，输出校验失败不重试。

模型选择只能通过 `LLM_MODEL` 配置；候选模型上线前按[模型兼容性验证记录](llm-model-compatibility.md)执行脱敏比较，不在 Worker 启动时调用 `/models`。

`CLOUDFLARE_API_TOKEN` 必须拥有 Cloudflare GraphQL Analytics 只读权限并覆盖告警 `zone_tag` 对应 Zone。`WECOM_WEBHOOK_URL` 必须是企业微信机器人完整 Webhook URL。

不要把真实值写入 `wrangler.jsonc`、Git、文档、夹具或日志。

## 本地配置

本地 `npm run dev` 可从仓库根目录的 `.dev.vars` 读取同名变量：

```dotenv
CLOUDFLARE_API_TOKEN="local-read-only-token"
LLM_API_KEY="local-relay-key"
WECOM_WEBHOOK_URL="https://example.invalid/wecom-test-webhook"
LLM_BASE_URL="https://relay.example.invalid/v1"
LLM_MODEL="relay-model-name"
```

`.dev.vars*` 已被 Git 忽略。本地测试使用 Fetch Mock，不得填写或调用真实企业微信机器人。

## 部署前门禁

```bash
npm ci
npm run types
npm run typecheck
npm run lint
npm test
npx wrangler deploy --dry-run --keep-vars
openspec validate implement-waf-alert-analyzer-mvp --strict
openspec validate structured-evidence-references --strict
```

`--keep-vars` 用于保留 Dashboard 中管理的 `LLM_BASE_URL` 和 `LLM_MODEL`。所有命令必须退出码为 0。

## 端到端验证

1. 向 `POST /api/v1/alerts/cloudflare` 发送脱敏的有效 WAF Payload。
2. 确认只有 Queue 入队成功后才返回 `202 Accepted`。
3. 确认 Queue 按 `settle_seconds` 延迟投递且 `max_batch_size = 1`。
4. 使用相同 `incident_id` 和 `correlation_id` 关联 Workers Logs。
5. 确认 Queue 重试不修改 `query_started_at` 或 `analysis_window`。
6. 确认 GraphQL 使用 `total_events` 计算比例，并保留 Payload `events_count` 作为参考。
7. 确认 LLM 请求发往 `LLM_BASE_URL + /chat/completions`，模型为 `LLM_MODEL`，单次调用使用解析后的 `llmTimeoutMs`。
8. 模拟 LLM 不可用，确认规则降级通知仍能发送。
9. 模拟企业微信最终失败，确认记录 `notification_failed` 且不重跑 GraphQL 或 AI。
10. 检查日志不含 Token、API Key、Authorization 或企业微信 Webhook URL。

## Dashboard 同窗口核验

结构化引用升级额外核验：响应为 schema_version=2，每条风险/攻击/观察/建议具有独立引用；不存在、重复、类型错误、缺少支持和数据不足确定结论分别有受控错误分类。错误通知仍含原统计和规则。一次正常采集为两次 GraphQL HTTP（聚合和样本）；输出失败时 LLM 一次，企微发送成功时一次，Queue ack、不 retry。仅 LLM 429/5xx 和通知自身临时失败按既有策略重试，不重做采集。

先运行本地 Workers mock 测试；真实 Provider/机器人验证须明确授权和环境范围。已授权的首次 `.env` Provider 烟测中，结构通过 3/3、完整引用支持校验通过 2/3，尚未达到稳定通过门槛，未完成远端部署验证；复测入口为 `npm run test:llm:live`。日志仅检查 code/reason、受控路径及计数，不收集 Prompt、模型原文、实体值或引用 ID。关注 Unknown/降级率与通知成功率，不能把支持校验通过解释为攻击已被证实。

使用通知中的同一个 `analysis_window.start` 与 `analysis_window.end` 核验：

- `total_events`
- Top IP
- Top Path
- Top Country
- Top ASN
- Action

记录可解释的采样、聚合或口径差异。

## 回滚

将 Prompt、Schema、支持规则、Formatter 与诊断整体恢复到同一已验证代码版本。旧 Queue 消息仍兼容，不迁移窗口或 Secret；不能只回滚输出字段或同时保留旧自然语言实体扫描。恢复旧版也会恢复已知误报机制，需记录该风险。

验证失败时部署上一已验证 Worker 版本。不要扩大在途 Queue Message 的固定窗口，不要清空 Queue 或删除远端资源。必要时暂停 Queue consumer，并保留脱敏日志和事件身份标识。
