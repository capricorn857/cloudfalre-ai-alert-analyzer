# 实施任务：聚合差异时保留 Host 分析

> 实施阶段使用 superpowers:executing-plans 与 test-driven-development 按任务推进。用户于2026-10-09批准实施；按验证结果更新复选框，未完成项不得勾选。

**Goal:** 静默资格与可用Host解耦，普通聚合差异保留原多Host通知。
**Architecture:** Client只解析观察，纯函数判定静默/质量，Analyzer保留过滤Host，统计与Evidence显式传播可比性，Formatter/Pipeline保留局部结果和终态安全。
**Tech Stack:** 现有TypeScript strict、Workers、Queues、Fetch、Zod、Wrangler、Vitest/@cloudflare/vitest-plugin、ESLint/npm，不加SDK/框架/存储。

## 全局约束

- 用户明确批准已记录，proposal为approved；不把CLI文件齐全视作实施完成。
- 先失败测试再最小实现；仅改本设计列明模块。所有测试Fetch Mock/虚构数据，不调用真实LLM或企微。
- 固定Queue窗口、schemaVersion1、hostLimit1..5默认3、发现Top10、并发2、90秒截止、正常1+2H HTTP/4+8H nodes、技术重试至多2次不变。
- 保持exclude-exact-block-v1、Catalog v2/AI v3和全部证据支持、结构、归属及字节预算，不新增绝对完整采样前置门禁。
- 不提交、推送、合并、部署、写Secrets/Cloudflare资源、同步主Specs或归档；任一后续操作需要单独指令。

## 任务

以下步骤以design A1–A16作为明确输入/期望；每组先记录回归RED，再GREEN，父任务只在子项及针对性验证通过后勾选。

## 1. 确认能力边界与实施影响范围。

- [x] 1. 确认能力边界与实施影响范围。
  - [x] 1.1 用户批准后核对proposal基线与当前HEAD/工作区；检查四个delta、design和任务版本一致，记录批准并通过工作流及OpenSpec严格校验。
  - [x] 1.2 核对test/fixtures/graphql/blocked-action-schema-contract.json与host-schema-contract.json的真实历史观测；将旧runtimeProtection说明与新质量判定区分，保留原始历史结果。以Mock验证未知Action有Host/无Host均不静默；产出已证实/未证实清单，不声称null被action_neq保留。
  - [x] 1.3 若另获明确只读目标Zone/窗口与凭证使用范围，核验非空混合过滤排名/样本否定语义；未获得则记录外部限制，以既有已验证查询形状和保守未知范围处理实施，不构造action:null、不调用LLM/企微，不为证明绝对采样覆盖阻塞修复。
  - [x] 1.4 运行gitnexus status并刷新当前修复分支索引；对discoverZone、ScopedDiscoverySchema、decideSuppression、analyzeHostWafAlert、analyzeHost、summarizeCoverage、buildHostEvidenceCatalog、runHostAIAnalysis、formatHostWeComMessage、processHostAlert做impact并rg核对调用方。记录HIGH/CRITICAL复核，超出design范围先修订规划。

## 2. TDD实现发现质量与静默判定（A1、A2、A5、A8、A9、A11、A12）。

- [x] 2. TDD实现发现质量与静默判定（A1、A2、A5、A8、A9、A11、A12）。
  - [x] 2.1 在test/unit/analysis/suppression.test.ts和test/unit/domain/event-scope.test.ts增加判定表：1360/1362/0/空Top静默；零Zone正Host继续；未知/截断有Host继续但partial；无Host非block、raw0正Action、raw正Action空、零Top条目不静默。确认旧实现因业务断言失败。
  - [x] 2.2 修改src/domain/event-scope.ts定义Zod质量及reasonCodes，src/analysis/suppression.ts实现decideSuppression(input: ScopedDiscovery): SuppressionDecision；静默与continue/degrade分离，quality携带可比性和比较结果，unsafe计数/和拒绝而非容差。
  - [x] 2.3 在test/integration/blocked-graphql-client.test.ts与test/unit/clients/cloudflare-graphql-schema.test.ts补真实Client解析回归：raw1360/action1362时直接block为1362；缺alias、null、errors、非法计数失败；缺失Action被识别未知。运行确认旧相等门槛RED。
  - [x] 2.4 修改src/clients/cloudflare-graphql.ts的discoverZone与必要响应标准化：结构完整性不依赖raw相等，四alias查询及谓词不变，不相减；在src/clients/cloudflare-graphql-schema.ts维持关键响应严格校验。运行本组测试全GREEN。

## 3. TDD保留Host采集及局部质量（A3、A4、A8–A11、A13）。

- [x] 3. TDD保留Host采集及局部质量（A3、A4、A8–A11、A13）。
  - [x] 3.1 在test/unit/analyzers/host-waf-analyzer.test.ts补带两Host的原始差异、T0正Host、未知/截断有Host及单Host失败测试；断言collectHostSnapshot实际被调用、窗口恒定、所有选中Host状态保留。先确认旧提前return/空选择导致RED。
  - [x] 3.2 修改src/domain/analysis-result.ts及src/domain/host-analysis.ts携带quality与no_usable_hosts原因；src/analyzers/waf-analyzer.ts只在suppress跳过全部流程，有有效H即按既有选择/并发/预算采集，T0不清空；协议失败仍collection_failed。
  - [x] 3.3 在test/unit/analysis/host-statistics.test.ts补发现600/细查610、T0正Host、Top和>T、原始正数差异但过滤一致、Action/Source差异、TopN和小于总量的比例矩阵；确认受影响比例断言RED。
  - [x] 3.4 修改src/analysis/host-analysis.ts的analyzeHost和summarizeCoverage显式接收zoneDenominatorComparable；必要调整src/analysis/statistics.ts、rules.ts，可靠内部统计保留、相关比例null、未知比例不生成确定性Finding。运行本组与统计/规则既有测试GREEN。

## 4. TDD贯通Evidence与AI局部降级（A3、A4、A6、A8、A10）。

- [x] 4. TDD贯通Evidence与AI局部降级（A3、A4、A6、A8、A10）。
  - [x] 4.1 在test/unit/analysis/host-evidence.test.ts、host-ai-analyzer.test.ts和test/integration/host-llm-client.test.ts补T0正Host仍构建合法Host目录、raw不进入Host证据、未知范围不可用于覆盖结论、单Host非法输出不影响其他Host的测试。先记录失败，再调整。
  - [x] 4.2 修改src/analysis/host-evidence.ts与src/domain/host-evidence.ts使buildHostEvidenceCatalog接收与Analyzer相同质量投影；可靠Host内证据不被Zone质量全局拒绝；src/analysis/ai-analyzer.ts及Formatter重建调用方同步传参。保持根级非法响应拒绝与Host局部降级，不改变AI wire/Catalog版本或放宽支持门槛。
  - [x] 4.3 运行上述测试及test/unit/analysis/evidence.test.ts、test/unit/domain/evidence-catalog.test.ts，确认跨Host、错误分母、独立排名关系、伪造字段和预算越界仍拒绝；可靠Host通过。保留具体RED/GREEN证据。

## 5. TDD恢复多Host通知与预算（A3–A5、A8、A10、A16）。

- [x] 5. TDD恢复多Host通知与预算（A3–A5、A8、A10、A16）。
  - [x] 5.1 在test/unit/notification/host-formatter.test.ts与test/fixtures/host-notifications.ts补真实log/skip/allow分布、聚合差异多Host、零Zone正Host、原始非block无Host、未知范围提示、五Host长字段完整ID快照；先确认旧全局模板/分布概括断言RED。
  - [x] 5.2 修改src/notification/host-formatter.ts保留编号Host、计数/Zone占比、真实Action计数与可用比例、IP/路径/国家/ASN/触发来源与必要降级；无Host按具体原因显示事实。零Zone正Host明确冲突；不输出全block文案或已过滤block建议。
  - [x] 5.3 使用既有src/notification/blocks.ts整块省略/公平预算；新增质量限定为必需块。测试断言new TextEncoder().encode(text).byteLength≤2000、所有Host最小状态、窗口/完整ID/必要限定存在，历史不可表示消息受控失败；本组GREEN。

## 6. TDD判定日志及终态安全（A12、A14、A15）。

- [x] 6. TDD判定日志及终态安全（A12、A14、A15）。
  - [x] 6.1 在test/integration/blocked-events-pipeline.test.ts、log-redaction.test.ts、wecom-client.test.ts补具体比较原因/数值/未知分类/截断/Top计数/比例失效、真实ai_called/wecom_called、logger抛错与同文本重试断言；先记录缺字段或错误路径RED。
  - [x] 6.2 修改src/pipeline/process-alert.ts及必要src/observability/logger.ts投影受控日志：decision_version、最终decision、reasonCodes、固定身份/窗口、计数与比较、invalid_ratios及实际调用状态。未知原始Action字符串归other_non_block/unknown，不写实体/Secret；所有观察异常与业务终态隔离。
  - [x] 6.3 运行本组及test/integration/queue-handler.test.ts；确认静默AI0/企微0/ack1/retry0，发送成功logger异常ack1/retry0，通知有限重试重用相同字节文本且GraphQL/LLM调用数不增加。

## 7. Workers端到端覆盖与全量验证。

- [x] 7. Workers端到端覆盖与全量验证。
  - [x] 7.1 在test/integration/blocked-worker.test.ts、blocked-events-pipeline.test.ts、blocked-graphql-client.test.ts补A1–A16完整回归映射，特别是同IP/Host混合动作、原Top全block其他Host入选、未知有Host和无Host；使用真实Handler/Client/Formatter与Fetch Mock，不仅mock判定返回值。
  - [x] 7.2 在既有@cloudflare/vitest-plugin运行针对性Workers集成，断言固定窗口、请求预算、Host局部失败、企微同文本重试和终态日志异常；没有额外业务轮次、Queue wire/bindings变化或生产网络调用。
  - [x] 7.3 运行npm run typecheck、npm run lint、npm test，记录实际结果；仅如bindings实际变化才运行npm run types并重新核对范围，本修复预期不变。
  - [x] 7.4 在禁止dotenv加载的环境执行本地Wrangler dry-run到/tmp目录，确认只构建校验不上传、不调用远端资源；记录bundle/退出状态。
  - [x] 7.5 运行gitnexus detect-changes --scope all，核对实际符号/调用链与design；HIGH/CRITICAL重新核对调用方、测试及范围，异常越界不标完成。
  - [x] 7.6 复核A1–A16、Credential/日志泄漏、git diff --check及全部修改路径，重新运行OpenSpec严格/工作流校验；写入实现验证证据并在全部完成后才设implemented。报告已知外部能力限制和主Specs同步顺序，等待用户后续指令，不自动提交/同步/归档/部署。

## 关键回归断言示意

下列为已批准规划的关键测试示意，实现阶段需以实际回归验证：

```ts
const result = decideSuppression({
  ...ATTENTION_SCOPE,
  rawTotalEvents: 1360, zoneTotalEvents: 0,
  blockedTotalEvents: 1362, countQuality: "estimated",
  rawActions: [{ action: "block", count: 1362 }], topHosts: [],
});
expect(result.kind).toBe("suppress");
// 同一事实经过真实 discoverZone 解析也必须保留 blockedTotalEvents=1362。
// T=0但存在正Host：采集该Host，返回partial，zoneShare/coverage.ratio为null。
// 原始不一致但过滤Host自身一致：明细和该Host内部Evidence继续可用。
```

实现接口以design的数据契约为准；先由Schema推导类型再贯通各调用方，不通过any或跳过验证消除类型错误。

## 验证命令

针对性组先RED后GREEN，成功预期为所选测试全部通过；全量命令成功预期exit0，无生产操作：

```bash
npm test -- test/unit/analysis/suppression.test.ts test/unit/domain/event-scope.test.ts test/integration/blocked-graphql-client.test.ts test/unit/clients/cloudflare-graphql-schema.test.ts
npm test -- test/unit/analyzers/host-waf-analyzer.test.ts test/unit/analysis/host-statistics.test.ts
npm test -- test/unit/analysis/host-evidence.test.ts test/unit/analysis/host-ai-analyzer.test.ts test/integration/host-llm-client.test.ts test/unit/analysis/evidence.test.ts test/unit/domain/evidence-catalog.test.ts
npm test -- test/unit/notification/host-formatter.test.ts
npm test -- test/integration/blocked-worker.test.ts test/integration/blocked-events-pipeline.test.ts test/integration/log-redaction.test.ts test/integration/wecom-client.test.ts test/integration/queue-handler.test.ts
npm run typecheck
npm run lint
npm test
CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false CLOUDFLARE_LOAD_DOT_ENV=false npx wrangler deploy --dry-run --outdir /tmp/preserve-host-analysis-dry-run
gitnexus status
gitnexus analyze --branch fix/preserve-host-analysis-on-aggregate-mismatch --name cloudflare-ai-alert-analyzer --skip-agents-md --skip-skills
gitnexus impact decideSuppression --repo cloudflare-ai-alert-analyzer --branch fix/preserve-host-analysis-on-aggregate-mismatch
gitnexus detect-changes --scope all
git diff --check
openspec validate preserve-host-analysis-on-aggregate-mismatch --strict
python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/preserve-host-analysis-on-aggregate-mismatch
```

其他共享符号使用任务1.4所列名称逐项impact，同名符号用UID/文件消歧，不能只查decideSuppression代表全部影响。索引写入权限不足需明确工具权限处理，不以过期图冒充完成检查。

