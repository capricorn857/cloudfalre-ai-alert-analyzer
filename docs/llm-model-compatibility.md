# LLM 模型兼容性验证记录

本文包含本地实测入口、验证记录和上线前的人工验证模板，不包含真实 Router URL、Token、API Key、Webhook URL 或模型原文。固定模型烟测只调用配置接口的 `/chat/completions`；模型选型比较才需额外查询 `/models`。结果只保存受控诊断与数量指标。

## 本地实测命令

在仓库根目录的 `.env` 中准备 `LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，然后运行：

```bash
npm run test:llm:live
```

该命令会真实调用已配置的 LLM，可能计费。它以 Node 标准 dotenv 解析器读取 `.env`，不执行文件内容；仅将上述三个字段传入独立 Workers 测试环境，不配置 GraphQL、Queue 或企业微信 binding。使用虚构夹具、生产 LLMClient、生产 Zod 与支持验证器，连续执行 3 次，单次超时 30000 ms、输出预算 2048 tokens。仅保留 Client 现有 429/5xx 一次重试，不重试非法输出；拒绝自动跟随重定向。

每轮输出 `live_llm_result`，末尾输出 `live_llm_summary`。3 次全部通过才 exit 0，否则 exit 1；合法 Unknown 算通过。报告没有实际接口地址、模型名、API Key、目录值、引用 ID、Prompt 或模型原文。`headers_ms` 指 Fetch 收到响应 headers 的等待时间，不冒充精确网络 TTFB。

默认 `npm test` 不包含 `.live.ts`，仍只跑本地 Mock 测试。只验证入口和报告器、不调用 LLM：

```bash
npm run test:llm:live -- -t 'supports requests'
```

## 首次真实接口结果

2026-09-23 实测，2026-09-24 整理记录。用户明确授权读取本地 `.env` 调用当前模型；没有调用 `/models`、Cloudflare 或企业微信，没有写 Secret 或部署。

| 轮次 | HTTP | 总耗时 ms | completion tokens | JSON/Zod 结构 | 引用与支持 |
| --- | --- | --- | --- | --- | --- |
| 1 | 200 | 16154 | 728 | 通过 | 拒绝 |
| 2 | 200 | 15381 | 767 | 通过 | 通过，attack Unknown |
| 3 | 200 | 15854 | 653 | 通过 | 通过，attack Unknown |

三次均 finish_reason=stop，各一次 HTTP 请求，无截断。第 1 次为 `ai_claim_unsupported` / `support_condition_failed`，受控路径 `attack.evidence_ids`。未记录原文，因此不进一步臆测具体模型引用值。结构通过 3/3，完整通过 2/3；测试按全部通过门槛 exit 1。说明接口能接收新 Schema 并生成结构有效响应，但当前模型尚未在该样本上稳定满足支持规则。这只是小样本烟测，不是稳定性或所有关键字支持的证明，也不授权部署。

首次入口调试中使用了 Workers 不支持的 redirect=error，产生三个毫秒级本地传输失败；经无网络断言确认并改为 redirect=manual 后才得到上述真实 HTTP 结果。本地请求构造失败未混入 Provider 兼容性统计。

## 固定验证输入

使用虚构 Incident、程序计算的 Statistics/Findings 生成 Catalog v1，输入与 Worker 一致，响应要求 AI v2。可用 `test/fixtures/evidence-catalog.ts` 和 `test/fixtures/llm/valid-output.json` 作为固定样本；旧 `legacy-output.json` 必须被拒绝。请求要求 `response_format.type=json_schema`、`json_schema.strict=true`，Schema 由同一个 `AIAnalysisWireSchema` 导出，并使用待测 `LLM_MODEL`。不要把真实告警、凭证、完整 Prompt 或完整响应写入记录。

普通自动化测试只验证请求构造和 mock 响应；上述独立真实接口烟测使用已授权的本地配置。扩展到其他模型或环境的探测仍需明确范围，不发送生产企业微信。必须区分结构通过与引用/支持通过；不能以降低 Unknown 为由放宽支持约束。

## 采集指标

对 `/models` 返回的候选模型逐一执行固定次数请求，记录：

- HTTP 状态；
- 首字节耗时（TTFB）和总耗时；
- 规范化 `finish_reason`（未知值仅记 unknown）；
- JSON 解析成功率；
- LLM Schema 校验成功率；
- Evidence 校验成功率；
- 分类错误码计数（仅错误码和安全路径，不记录字段值）。

每次请求最多按 Worker 规则对 `429`/`5xx` 重试一次；验证记录应区分首次和最终结果。当前 `gpt-5.5` 的受控结果作为延迟基线，比较必须使用同一输入、同一窗口和同一请求预算。

## 推荐门槛

只有同时满足以下条件才可提出人工模型切换建议：

1. `/chat/completions` 可用；
2. 支持 `response_format=json_schema` 和 `strict=true`；
3. 固定样本中结构化输出稳定，Schema 与 Evidence 成功率达到发布门槛；
4. TTFB 和总耗时均低于当前 `gpt-5.5` 基线，且没有更高的重试率。

验证不会修改 `LLM_MODEL`，也不会自动部署。确认切换后仅由授权人员更新现有 `LLM_MODEL` 配置，并按发布清单执行回滚准备。

契约升级失败时回滚整包 Worker 版本，不能单独保留旧 Prompt 或旧正则验证器；旧版误报风险随回滚恢复。v2 仅验证程序规定的证据支持条件，不证明模型全部语义判断正确。
