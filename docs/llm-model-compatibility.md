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

以下为历史 Catalog v1 / AI v2 结果，不能作为当前多Host Catalog v2 / AI v3 的兼容性证明。当前v3真实烟测结果见下一节，尚未通过发布门禁。

2026-09-23 实测，2026-09-24 整理记录。用户明确授权读取本地 `.env` 调用当前模型；没有调用 `/models`、Cloudflare 或企业微信，没有写 Secret 或部署。

| 轮次 | HTTP | 总耗时 ms | completion tokens | JSON/Zod 结构 | 引用与支持 |
| --- | --- | --- | --- | --- | --- |
| 1 | 200 | 16154 | 728 | 通过 | 拒绝 |
| 2 | 200 | 15381 | 767 | 通过 | 通过，attack Unknown |
| 3 | 200 | 15854 | 653 | 通过 | 通过，attack Unknown |

三次均 finish_reason=stop，各一次 HTTP 请求，无截断。第 1 次为 `ai_claim_unsupported` / `support_condition_failed`，受控路径 `attack.evidence_ids`。未记录原文，因此不进一步臆测具体模型引用值。结构通过 3/3，完整通过 2/3；测试按全部通过门槛 exit 1。说明接口能接收新 Schema 并生成结构有效响应，但当前模型尚未在该样本上稳定满足支持规则。这只是小样本烟测，不是稳定性或所有关键字支持的证明，也不授权部署。

首次入口调试中使用了 Workers 不支持的 redirect=error，产生三个毫秒级本地传输失败；经无网络断言确认并改为 redirect=manual 后才得到上述真实 HTTP 结果。本地请求构造失败未混入 Provider 兼容性统计。

## 当前 v3 真实接口结果

2026-09-29，用户授权使用本地 `.env` 实际测试，执行 `npm run test:llm:live`。仅加载三个LLM字段，使用单Host虚构Catalog v2，连续请求3次；未调用Cloudflare、企业微信或部署。首次沙箱内运行因本地端口EPERM未启动测试，获得执行权限后完成真实调用。

| 轮次 | HTTP | 总耗时 ms | completion tokens | 结构及支持校验 |
| --- | --- | --- | --- | --- |
| 1 | 200 | 13932 | 661 | 通过，attack Unknown |
| 2 | 200 | 24405 | 1265 | 正文超预算，解析前拒绝 |
| 3 | 200 | 15015 | 685 | 通过，attack Unknown |

三轮各一次HTTP请求，finish_reason均为stop。第2轮为 `llm_output_truncated`，源码核对确认触发32 KiB content预算，并非finish_reason=length。诊断content_length=65535已达到计数封顶，不能将其作为精确长度；未保留原文，无法确定正文膨胀的具体内容或上游原因。客户端按现有契约拒绝，无非法输出重试，未放宽预算或支持规则。

完整通过2/3，命令exit 1，未达到3/3烟测门槛。该结果仅覆盖单Host虚构输入；3/5 Host真实兼容性、真实告警采集、企微发送及端到端验收仍未完成，不构成上线依据。

2026-09-29后续按用户指定历史告警窗口进行真实数据模拟：Zone共478事件、发现1个Host、独立聚合478事件及50条样本；Catalog9568 bytes，1次LLM调用通过结构及支持校验，攻击类型Unknown。本轮成功不能覆盖前述2/3失败记录，亦非3/5 Host稳定性证明。细节见 `openspec/changes/host-scoped-alert-analysis/verification.md`；真实数据及通知预览未写入仓库。

## 固定验证输入

当前使用 `test/fixtures/host-ai.ts` 与 `test/fixtures/host-analysis.ts` 的虚构Host分析生成Catalog v2，响应要求AI v3。旧自由文本及v2响应均拒绝。请求要求 `response_format.type=json_schema`、`json_schema.strict=true`，Schema由 `MultiHostAIWireSchema` 导出。每Host至多3条观察、2条建议；默认输出预算仍2048 tokens，最多5Host时截断会整体降级，不另开模型请求。目录56 KiB、messages64 KiB、请求体96 KiB、响应体128 KiB、content32 KiB均有硬限制。

后续获授权的真实验证应分别覆盖单Host、默认3Host、最大5Host、局部无效输出和根结构无效。记录逐Host支持成功率、Unknown/降级率及截断率，不仅看HTTP200。不要把真实告警、凭证、Prompt或模型原文写入记录。

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

契约升级失败时回滚整包Worker版本，不能单独保留旧Prompt或旧验证器；回滚前一版本恢复Zone级分析和旧通知布局。v3仅验证程序规定的支持条件与Host归属，不证明攻击意图或模型所有语义判断正确。
