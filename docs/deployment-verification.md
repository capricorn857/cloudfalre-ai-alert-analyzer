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

## 历史窗口本地模拟

用户授权真实查询与LLM调用后，使用 `.env` 中配置执行独立Workers测试入口。示例中的域名和时间必须换为已授权目标：

```bash
LIVE_ZONE_NAME=example.test LIVE_ALERT_TIME=2026-09-29T15:10:03+08:00 npm test -- --config test/live/alert-simulation.config.mjs
```

默认仅生成本地通知预览；不会加载企微URL或调用企微。三个LLM字段及Cloudflare Token仅在内存中使用，业务参数使用仓库 `wrangler.jsonc` 的BUSINESS_CONFIG，不执行 `.env` 内容。只查询目标Zone并执行一次生产Host分析链路，不投递真实Queue，不触发线上Worker。

由于缺少原始Webhook接收时间，入口明确假定接收时间等于传入告警时间；Payload事件参考值以0占位，统计使用GraphQL总量。默认窗口为告警前30分钟至告警后60秒，每次查询与重试核验同一窗口。测试含一次Zone解析、有限GraphQL采集及一次逻辑LLM调用；允许生产Client规定的有限临时错误重试。

脱敏诊断与已校验通知预览保存在运行时新建的 `/tmp/host-alert-simulation-*` 目录，目录权限0700、文件0600；预览可能包含真实事件实体，应按敏感运维资料管理，不纳入Git。默认 `npm test` 不包含 `.live.ts`。

仅在用户明确授权向该机器人发送时增加 `LIVE_SEND_WECOM=true`；通知带历史模拟标记且总长不超过2000 UTF-8 bytes。发送是外部动作，不能为了重试测试而重复执行整个采集与LLM链路。预览模式下Pipeline的sent返回只代表本地适配器完成，不能当作真实投递证明。Cloudflare查询失败、AI局部降级或通知失败会令该验收入口失败，并保留受控诊断。

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

Host升级核验：响应为schema_version=3、目录为v2，每Host的风险/攻击/观察/建议具有独立引用与分母；跨Host、类型错误、缺支持、无依据联合关系均拒绝。单Host失败局部降级，根结构失败全部AI降级，程序规则与其他成功Host保留。正常采集HTTP=1+2H，默认Top3为7次，最多2路并发；90秒采集总截止含响应体与退避。LLM一个逻辑调用，企微一条文本；通知重试只复用已生成文本，成功后观测失败仍ack。

先运行本地Workers Mock测试；真实Provider/机器人验证仍须明确授权与环境范围。历史v2烟测结构3/3、完整校验2/3，不能作为当前v3验收记录；2026-09-29已授权v3单Host烟测完整通过2/3，一轮正文超预算被拒绝，尚未通过真实Provider门禁，也未完成3/5 Host、机器人或部署验证，详见模型兼容性验证记录。日志检查host_id、collection_stage、request_count、node_selection_count、coverage_status和受控code/reason，不收集Prompt、原文或实际Host/IP/Path。关注Unknown/降级率与通知成功率，不能把支持校验通过解释为攻击已证实。

使用通知中的同一个 `analysis_window.start` 与 `analysis_window.end` 核验：

- Zone总量、选中Host总量和可信覆盖比例（不编造总Host数）
- Top IP
- Top Path
- Top Country
- Top ASN
- Action

每个Host在相同窗口加精确Host过滤分别核验。Host内比例以Host总量为分母，非空UA样本单独计数；记录采样/聚合差异，不通过补查或缩窗消除差异。确认root/www的同名Path不再合并。

## 回滚

将采集、Prompt、Catalog/AI Schema、支持规则、Formatter与诊断整体恢复到同一已验证版本。Queue保持v1；新Consumer对缺失hostLimit固定默认3，旧Consumer忽略新增字段并恢复Zone级分析。不迁移窗口或Secret，不清空队列；记录回滚后的覆盖能力退化和跨版本重复通知风险。

验证失败时部署上一已验证 Worker 版本。不要扩大在途 Queue Message 的固定窗口，不要清空 Queue 或删除远端资源。必要时暂停 Queue consumer，并保留脱敏日志和事件身份标识。

## 已拦截事件静默发布核验

使用固定策略exclude-exact-block-v1，Queue/vars/bindings不变。对目标Zone核验rawTotal、attentionTotal、rawActions(limit20)、topHosts四alias及现有Host7聚合/样本查询。Action=null查询条件不可假设支持；通过未过滤分布完整性与计数比较保护未知类别，未知/缺失/截断/冲突发送基础通知而非静默。block数来自分布中的直接block组，不做采样差值。

非生产验证分别覆盖观察零（1次GraphQL、无LLM/企微、ack）、混合（默认H=3为7次GraphQL、待关注分母）、原始空（基础通知）、未知Action（基础降级）、污染样本（仅样本失败）。日志reason=no_attention_events_observed，observation_basis=adaptive_aggregate，明确接受稀少非block采样遗漏。企微成功与静默终态的日志异常都不能触发主动Queue重放。

发布需另行授权并整包切换Client/领域/Catalog/Prompt/Formatter，旧目录缺scope标识不得混用。回滚旧包恢复block噪声，不清空或迁移Queue、不重新计算窗口；不承诺跨版本策略快照或exactly-once。离线Mock不替代生产部署和真实Provider验收。
