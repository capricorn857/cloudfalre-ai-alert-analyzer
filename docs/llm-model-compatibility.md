# LLM 模型兼容性验证记录

本文是上线前的人工验证模板，不包含真实 Router URL、Token、API Key、Webhook URL 或模型原文。验证必须在受控环境运行，使用当前 `LLM_BASE_URL` 对应 Router 的 `/models` 和 `/chat/completions`，结果只保存聚合指标。

## 固定验证输入

使用脱敏、固定的 `Incident`、程序计算的 `Statistics` 和 `Findings`，与 Worker 发送的字段契约一致。请求必须要求 `response_format.type=json_schema`、`json_schema.strict=true`，并使用待测 `LLM_MODEL`。不要把真实告警、凭证、完整 Prompt 或完整响应写入记录。

## 采集指标

对 `/models` 返回的候选模型逐一执行固定次数请求，记录：

- HTTP 状态；
- 首字节耗时（TTFB）和总耗时；
- `finish_reason`；
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
