# 实施验收记录

日期：2026-09-23。分支：`feat/structured-evidence-references`。起点：`cdaf7dc`。用户已审计并明确授权实施；未授权发布。

## 实施结果

- Catalog v1：已校验领域输入的有界派生视图，固定类型/来源/口径/ID，100 项、128 KiB、2048-byte 业务值边界、null/省略及来源一致性检查。
- AI v2：封闭结构和逐条引用，Provider JSON Schema 从 wire Zod 生成。没有自由事实文案字段，旧输出拒绝。
- 支持验证：在 AI Analyzer 统一执行，检验引用存在、重复、角色、Finding/stat 配对、阈值、数据充分性、风险最高等级、Bot 门槛、Unknown 和建议边界。旧 IP/Path/ASN 与自动动作自然语言扫描已删除。
- 展示：只读、不可伪造的验证结果携带冻结目录；Formatter 核对 snapshot 的目录投影一致，按模板读取事实。该核对不调用 GraphQL 或重新计算 Statistics/Findings。长值按完整字段省略，普通点号、query、大小写、中文、UA 保真，控制符转义。
- 诊断：固定 code/reason、白名单路径、计数；Error 原始 name/message/cause 不输出。目录错误为本地 analysis_failed。Client 得到目录副本，不能改写之后校验所用目录。
- 失败隔离：规则降级照常通知；已验证一次采集两次 GraphQL HTTP、统计/规则各一次、输出失败 LLM 一次、通知成功一次、Queue ack 一次且无 retry。仅保留现有外部临时错误的阶段内有限重试。

## TDD 与回归证据

实施前基线：`npm test`，28 文件 / 171 测试通过。

| 阶段 | RED | GREEN |
| --- | --- | --- |
| 目录生成/Schema | 新导出缺失，目标测试失败 | 最终目录两文件 22 测试通过 |
| 封闭模型输出 | 新 wire Schema 缺失，9 测试失败 | 新契约 9 测试通过 |
| LLM Client | 8 失败 / 15 通过；随后 Prompt 支持表断言失败 | 恢复原传输回归后 27 测试通过 |
| 支持规则 | 28 测试失败，旧实体扫描不能处理新目录 | 扩充各维度、LOW/MEDIUM、空数据后 35 测试通过 |
| AI Analyzer | 原实现放行 mock Client 的无支持结论；另复现 Client 改写目录绕过 | 7 测试通过 |
| 诊断 | 缺白名单模块；额外复现 Error 文本、伪造计数/布尔字段泄漏 | 诊断 + logger + 日志集成 12 测试通过 |
| Formatter | 旧自由文本字段失效，7 失败；新增三个审查反例均失败 | 长字段、同窗口不同事实、风险限定语修复后 11 测试通过 |
| Workers 隔离 | 新错误投影断言缺字段，失败矩阵出现预期失败 | 新端到端故障矩阵 11 测试通过 |

最终命令与结果：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | exit 0，33 文件 / 248 测试通过，Workers Vitest 插件 |
| `npx wrangler deploy --dry-run --outdir /tmp/structured-evidence-references-dry-run` | exit 0，只打包，未上传或部署 |
| `openspec validate structured-evidence-references --strict` | valid |
| `python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/structured-evidence-references` | passed |
| `git diff --check` | exit 0 |

bindings 和 compatibility_date 未变，因此没有重新生成 `worker-configuration.d.ts`。测试工具存在既有 punycode 弃用提示，不影响结果。

## 审查与影响

独立代码审查提出四项有效问题：必保留内容绕过长度预算、相同域名/窗口混用不同目录、Error 原文日志通道、风险缺少限定语。均以新增失败反例定位后修复并通过全量回归。另已对齐 Prompt 中 insufficient_data 的无支持攻击假设条件。复核没有将模型全部语义正确性作为可验证承诺。

最终诊断复核另发现并复现：语义验证迁到 Analyzer 后，成功 LLM 响应的 finish reason、耗时和 token 计数未进入引用失败日志。失败矩阵新增元数据断言先 RED，再使用短生命周期受控元数据关联补齐；不存储 Prompt、原文或实体值，不增加请求或模型输出字段。

GitNexus 在沙箱内刷新曾无诊断退出，`status` 的 commit 一致不足以证明新增符号存在。最后在沙箱外使用 `--force --index-only --skip-agents-md --skip-skills` 重建成功：1305 nodes、2275 edges、74 flows；未改团队说明。使用功能分支索引重新查询新增符号。

`gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer --branch feat/structured-evidence-references` 成功：41 文件、263 符号、52 流程，CRITICAL，包含最终诊断修复及验收文档。`buildEvidenceCatalog` 影响 5 符号、CRITICAL；`validateAIAnalysisEvidence` 影响 1、LOW；共享 AppError/toExternalFailure 的 CRITICAL/HIGH 已在批准设计中披露。

重新核对的调用链包括 runAIAnalysis -> 目录/支持验证、Formatter -> 目录匹配、Pipeline -> 错误投影及通知；均在批准范围内。GraphQL/WeCom 原错误和重试、Queue、路由及窗口回归已随全量测试通过。没有修改 GraphQL 查询、统计/规则算法、Handler、Queue Message、bindings、Secret 或云资源。

为让差异检测覆盖新文件，已使用 `git add -N` 登记新路径；没有暂存实际文件内容或创建提交。源码搜索确认旧提取正则/模型自由文本展示入口不存在。Credential 检查仅发现原有虚构测试值/占位配置，未读取或复制真实凭证到变更。

## 边界与后续

- 确定性验证只证明符合受控支持策略，不能证明攻击意图、真实流量代表性或所有模型语义判断正确。
- 正则误报机制已被替换；没有声称已证明给定历史线上失败的具体实体或唯一根因。
- 实施验收时未调用真实 LLM Provider 或企业微信机器人；随后用户独立授权读取 `.env` 调用当前 LLM，结果见下节。始终未调用真实企业微信机器人。
- 未提交、推送、合并、部署、写 Secret 或变更 Cloudflare 资源；未同步主 Specs、未归档前序或本 Change。

## 授权后的 Provider 烟测

用户明确告知三项 LLM 配置在本地 `.env` 并授权读取调用。新增独立 `npm run test:llm:live`，使用现有 Workers Vitest 插件、虚构目录及生产 Client/验证器；默认测试不执行真实网络。未修改运行时生产行为或模型支持规则。

2026-09-23 取得真实响应，2026-09-24 整理结果：3 次 HTTP 200、JSON/Zod 全通过、finish_reason 全为 stop；总耗时 16154/15381/15854 ms，completion tokens 728/767/653。完整引用与支持校验通过 2/3；第 1 次在 attack.evidence_ids 以 ai_claim_unsupported/support_condition_failed 拒绝，按预期门槛实测命令 exit 1。未持久化模型原文或实际配置。详细命令及调试环境限制见 `docs/llm-model-compatibility.md`。

该结果说明新 Schema 可以被当前接口接受，但不等于模型稳定遵守支持规则，不构成部署验收通过。未通过的输出仍应按现有机制规则降级；本次不通过放宽验证来改善通过率。

实测入口最终验证：`npm run typecheck`、`npm run lint`、OpenSpec 严格/工作流校验、`git diff --check` 均通过；默认 `npm test` 仍为 33 文件 / 248 测试全部通过，未包含 live 测试。无网络入口检查与报告器输出通过。真实接口 2/3 的失败结果单独保留，不混入 Mock 测试通过结论。
