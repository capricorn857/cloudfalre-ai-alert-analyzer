# 实施验证记录

## 授权与工作区

2026-10-09用户批准实施当前Change。分支为fix/preserve-host-analysis-on-aggregate-mismatch，HEAD保持43184576da99b5bdc01b978cb15ec6d70fed03c1；沿用用户创建并审核的分支和工作区，不创建额外worktree、不提交。初始只有本Change未跟踪规划文件，无用户未提交源码修改。

## 实施前门禁

- proposal已设approved；OpenSpec严格校验与本Change工作流校验通过。四项MODIFIED主Specs缺失为已知同步依赖，未执行同步/归档。
- GitNexus新分支索引刷新成功，1967 nodes、3308 edges。沙箱首次无诊断失败，工具授权后在沙箱外刷新；不会修改AGENTS/技能文件。
- impact必须同时指定`--repo cloudflare-ai-alert-analyzer --branch fix/preserve-host-analysis-on-aggregate-mismatch`。ScopedDiscoverySchema使用Const UID消歧。discoverZone 1影响/LOW，ScopedDiscoverySchema 0/LOW，decideSuppression 0/LOW，analyzeHostWafAlert 3/LOW，analyzeHost 0/LOW，summarizeCoverage 0/LOW，buildHostEvidenceCatalog 5/HIGH，runHostAIAnalysis 3/LOW，formatHostWeComMessage 0/LOW，processHostAlert 2/LOW。
- HIGH为Evidence → AI/Formatter → Pipeline/Worker组合调用，均属于已批准design范围。图中0调用不等于无影响，已用源码rg核对Analyzer及Formatter真实调用，保留相应测试。当前不涉及新增接口或资源。

## 外部能力

复核历史两dataset introspection、settings、四alias接受和精确字符串聚合探测。历史结果只含全block/空样本，不能证明非空混合TopN、非空样本否定过滤或底层null/缺失/空串保留。当前没有新的目标Zone/窗口及凭证使用授权，未运行live GraphQL、LLM或企微。按批准的任务1.3记录限制并使用已核验查询形状继续，不要求绝对采样覆盖。

能力夹具保留历史观测和historicalRuntimeProtection副本；runtimeProtection更新为新判定说明，不把新策略伪装成新的外部实测。

## 已取得的RED证据

- `npm test -- test/unit/analysis/suppression.test.ts test/integration/blocked-graphql-client.test.ts`：11失败/31通过；预期差异包括1360/1362无法静默、未知/零Zone有Host被丢弃、无Host错误continue、unsafe和未拒绝，以及Client把直接1362置null。
- 全量基线启动期间已加入上述新测试，最终404通过/10个新suppression回归失败，无其他失败；因此不宣称该次是完全未修改的基线测试。
- `npm test -- test/unit/notification/host-formatter.test.ts test/integration/blocked-events-pipeline.test.ts`：8失败/23通过，确认真实Action未展示、缺质量限定/无Host已知事实、缺受控最终判定日志。Workers运行时曾因沙箱本地监听EPERM/日志目录EROFS不能启动，按工具权限流程在沙箱外重跑后取得真实断言结果。

## 最终验证（2026-10-09）

- 额外Client/Evidence RED：4失败/36通过（null/缺失/空Action直接block计数3例及伪造Zone占比1例）；修复后7个核心/Evidence测试文件112项全部通过。
- Analyzer/Host比例 RED：5失败/13通过；贯通后Host/Formatter/Pipeline/Worker五文件68项全部通过。
- 独立整体验证发现一个低优先级缺口：没有调用前判定日志。新增RED1失败/32通过后补上analysis_decision（before_external_calls，两个外部调用均not_requested），terminal alert_decision保留实际调用结果，针对性33项通过。复审无未解决发现。
- 首轮全量445通过/1失败，仅旧模板断言期待allow 87.5%；按已批准真实分类+计数结构更新为allow 350（87.5%），并同时断言log与managed_challenge计数/比例。
- **最终 `npm test`：48个文件、447项测试全部通过，exit0，129.00s。** 使用现有@cloudflare/vitest-plugin Workers运行时；缺少真实Secrets提示与punycode弃用提示为已知环境提示，测试使用虚构bindings/Fetch Mock，无live外部调用。
- `npm run typecheck`：exit0。`npm run lint`：exit0。曾捕获exactOptionalPropertyTypes要求显式处理可选boolean，已用与Formatter一致的true默认值完成兼容；生产Analyzer始终提供已校验quality。
- `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false CLOUDFLARE_LOAD_DOT_ENV=false npx wrangler deploy --dry-run --outdir /tmp/preserve-host-analysis-dry-run`：exit0，946.75 KiB/gzip158.29 KiB，明确--dry-run退出，无上传。首次沙箱构建成功但日志EROFS，工具授权后重跑无此错误。
- bindings、Queue wire、index.ts组合、依赖和AGENTS未变，故无需重新生成types。新增内容Credential模式扫描通过；人工核对日志只含受控分类/计数/原因，无IP、路径、凭证、模型原文或Webhook地址。
- `git diff --check`：exit0。OpenSpec严格/工作流校验通过；四项主Specs缺失Info为已记录的同步/归档依赖，不在本次处理。

## A1–A16验收映射

| 验收 | 实际覆盖 |
|---|---|
| A1、A2 全block/估计差异静默 | suppression单元；blocked-graphql-client直接计数；blocked-worker blocked/blocked_mismatch及日志异常 |
| A3 原始不一致保留Host | host-waf-analyzer raw_difference；host-formatter raw_mismatch；blocked-worker mixed_mismatch，真实Client→AI→消息 |
| A4 零Zone正Host | 上述zero_zone；host-statistics null分母；host-evidence零Zone仍保留Host目录 |
| A5 非block无Host | suppression no_usable_hosts；host-formatter已知上下文；blocked-worker nonblock_no_hosts |
| A6 同实体混合动作 | blocked-graphql-client全节点谓词/精确block污染拒绝/非规范Action保留；blocked-worker混合过滤与样本污染；host-evidence原始scope/block拒绝 |
| A7 原热门Host全block | blocked-worker mixed过滤后attention.example.test入选，GraphQL全节点过滤且AI无blocked Host |
| A8 未知Action | Client null/缺失/空串；suppression有Host与无Host；blocked-worker unknown/missing_action_hosts/empty_action_hosts |
| A9 截断 | suppression截断及重复；host-waf-analyzer/blocked-worker truncated_hosts保留明细 |
| A10 单Host局部失败 | host-waf-analyzer三Host聚合故障；host-statistics样本失败保留聚合；host-ai-analyzer单Host无效/缺失输出隔离；既有host-pipeline回归 |
| A11 GraphQL错误/缺失 | blocked-graphql-client必需alias/非法值；blocked-worker graphql_errors/missing_alias；既有failure-matrix |
| A12 三类零及部分可用 | suppression判定表；blocked-worker raw_empty/nonblock_no_hosts/blocked_mismatch，日志和文案独立 |
| A13 固定窗口/无新采集轮次 | blocked-worker各场景核对所有请求原始start/end、消息不变；host-waf-analyzer两并发/单发现/同deadline |
| A14 企微重试 | blocked-worker retries notification with identical bytes，3次GraphQL/1次AI/2次企微且文本完全相同；既有wecom-client |
| A15 终态日志异常 | blocked-worker静默和发送成功throwLog下ack1/retry0；blocked-events-pipeline静默日志抛错 |
| A16 字节预算 | host-formatter五Host/长字段/完整128-byte ID、控制字符ID、五Host局部失败；新增raw0/T0/未知Action/样本失败并存仍≤2000bytes且限定语完整 |

## 最终GitNexus完成检查

刷新最终分支索引成功：1994 nodes、3384 edges。随后在全部测试通过后执行：

`gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer --branch fix/preserve-host-analysis-on-aggregate-mismatch`

exit0；21个已跟踪文件、31个符号、33条受影响流程，风险 **CRITICAL**。已重新对照全部git diff路径、源码调用方与design组件边界：变化限定于Client/静默质量契约、Analyzer、Host Statistics/Evidence/AI投影、Formatter、Pipeline诊断及对应测试/能力说明；未修改Webhook、index.ts、Queue handler/消息、bindings、依赖或配置。受影响AI证据支持/字节预算/失败处理调用链由112项针对性与447项全量回归覆盖，独立最终审阅无遗留问题。CRITICAL表示跨链路影响广，不代表新增生产授权；未发现批准范围外修改。

## 交付状态与保留限制

Change已完成实现及离线验收，标记implemented，所有tasks完成。实现沿用现有统计和Schema即可保留多Host隔离，未为完成任务机械修改无须变更的graphql-schema/statistics/rules/domain-host-evidence文件；已有验证门槛未放宽。

仍未验证底层null/缺失Action否定保留、目标非空混合TopN及样本语义；本次不把Mock当外部实测，继续接受Adaptive少量遗漏风险。没有真实LLM/企微投递或Cloudflare资源变更；没有提交、推送、合并、部署、Specs同步或归档。前序主Specs同步顺序仍按proposal单独授权处理。

