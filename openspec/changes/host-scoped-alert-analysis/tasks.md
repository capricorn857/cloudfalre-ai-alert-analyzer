# 实施任务：按 Host 独立分析与企微通知优化

> 执行使用 superpowers:executing-plans、subagent-driven-development 与 test-driven-development；用户已明确审阅并批准实施，记录见proposal.md。任务1.2官方Schema/settings及空结果alias预算核验已完成，依据见verification.md与脱敏夹具。

目标：同一固定窗口的Zone总览与有限Host独立分析，保留安全结论边界并生成单条2000 UTF-8 bytes以内的企微通知。

架构：发现 -> 有限并发Host查询 -> Host纯函数统计/规则 -> Catalog2 -> 单逻辑LLM输出3及局部验证 -> 完整区块格式化 -> 独立发送重试。技术栈沿用TypeScript/Workers/Queues/Fetch/Zod/Vitest Workers插件/ESLint/npm。

## 全局约束

- 每个行为子任务先写测试并运行确认RED，再写最小实现并运行同命令GREEN。父任务只有子任务全部验收后才完成；批准实施不等于批准跳过任务1.2。
- 不修改前序Changes、主Specs，不自动同步/归档/提交/推送/部署，不读取真实Secret或调用真实外部服务。仅虚构fixtures和Fetch Mock。
- 固定Zone/窗口；hostLimit默认3、范围1..5并快照；每Host sampleLimit默认50/最大100；90秒采集截止、2 HTTP并发、GraphQL最多33尝试；单逻辑LLM，现有HTTP重试上限不扩张。
- Catalog2、AI3与Template同包；不增加攻击规则/存储/SDK/资源，不推断独立排名联合关系，不将失败变成零；所有新增DTO从Zod推导。
- 图分析HIGH/CRITICAL与官方Schema/settings门禁必须先处理；缺认证证据时不能把下面的候选查询当作可直接上线契约。
- 通知保留Host状态、防护、限定语、窗口和完整ID；新入口ID各128 UTF-8 bytes，旧消息不可表示时受控失败并ack。

## 任务

先完成批准记录、官方Schema/settings及当前分支影响核验，再依次执行配置兼容、采集、统计、证据、AI、通知、全链路与运行文档任务。任务1.2缺证据时保持未完成，不以Mock通过代替官方契约核验。

## 1. 审阅与查询能力门禁

- [x] 1. 确认授权及官方查询契约，验收为下列记录齐全且无未解决字段假设。
  - [x] 1.1 在本Change的proposal/design记录用户明确批准与范围（包括ID输入边界和CRITICAL影响），运行 `python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/host-scoped-alert-analysis`；依据实际批准和校验结果完成。
  - [x] 1.2 在新建 `test/fixtures/graphql/host-schema-contract.json` 和本design的核验节记录官方脱敏Schema/settings来源、日期、两dataset字段/filter/标量/nullability/orderBy/limit/aliases及目标限制；只有获授权的后续核验或用户提供的官方导出可完成。验收：无需真实凭证即可复核候选字段，limit/字段数/窗口均在目标限制内；不支持则先修订artifacts，停止查询实现。
  - [x] 1.3 在实际实施分支运行 `gitnexus status`、必要时带skip选项刷新，复跑 `gitnexus impact buildEvidenceCatalog --repo cloudflare-ai-alert-analyzer`、`gitnexus impact calculateStatistics --repo cloudflare-ai-alert-analyzer`、`gitnexus impact collectSnapshot --file src/clients/contracts.ts --repo cloudflare-ai-alert-analyzer`；结合 `rg -n 'collectSnapshot|buildEvidenceCatalog|formatWeComMessage' src test` 核对消费者，验收为影响均在本design范围且已获确认。

## 2. 配置与旧 Queue 兼容

文件：`src/config/env.ts`、`src/pipeline/window.ts`、`src/domain/queue-message.ts`、`src/api/cloudflare-alert.ts`、`src/domain/alert.ts`；测试 `test/unit/config/env.test.ts`、`test/unit/domain/queue-message.test.ts`、`test/unit/pipeline/window.test.ts`、`test/integration/cloudflare-alert-route.test.ts`。

接口：`WindowConfig.hostLimit`；`QueueMessage.configSnapshot.hostLimit`解析后必有；schemaVersion仍1；入口ID约束单独于历史Queue内部Alert Schema，避免拒绝历史长ID。

- [x] 2. 配置/入队可测试且新旧消息均不移动窗口。
  - [x] 2.1 写默认3、1/5通过、0/6/小数拒绝、缺字段旧消息固定3、配置改变后原hostLimit不变的失败测试；运行 `npm test -- test/unit/config/env.test.ts test/unit/domain/queue-message.test.ts test/unit/pipeline/window.test.ts` 确认RED，再最小修改上述三个模块至GREEN。
  - [x] 2.2 在路由测试加入128/129 UTF-8 bytes及多字节ID、握手不受影响、超限不入队；运行 `npm test -- test/integration/cloudflare-alert-route.test.ts` 先RED，再最小增加入口边界至GREEN，不能改变202/400/入队失败原语义。
  - [x] 2.3 新建 `test/fixtures/queue-v1.ts` 保存脱敏旧Schema行为与旧消息，在queue-message测试验证旧Consumer可读新增字段且strip、原窗口/ID/sampleLimit不变；运行 `npm test -- test/unit/domain/queue-message.test.ts` 并核对 `git show ce86425:src/domain/queue-message.ts`，验收为实际双向兼容而非仅测试新Schema。

## 3. Host 领域与采集客户端

文件：新增 `src/domain/host-analysis.ts`，修改 `src/domain/incident.ts`、`src/domain/analysis-result.ts`、`src/clients/contracts.ts`、`src/clients/cloudflare-graphql.ts`、`src/clients/cloudflare-graphql-schema.ts`。测试使用 `test/unit/domain/host-analysis.test.ts`、`test/fixtures/host-analysis.ts` 中的可复用虚构Host夹具，以及 `test/unit/clients/cloudflare-graphql-schema.test.ts`、`test/integration/cloudflare-graphql-client.test.ts`、`test/integration/host-graphql-client.test.ts`；不重复维护等价JSON夹具。

接口：`discoverZone(input: SnapshotCollectionInput): Promise<ZoneDiscovery>`；`collectHostSnapshot(input: SnapshotCollectionInput, host: SelectedHost): Promise<HostCollection>`，共享一次采集deadline/AbortSignal传递（由Analyzer持有，不在每Host重置）。`SelectedHost={hostId,host,discoveryCount}`；DTO字段/状态见design。

- [x] 3. 两阶段Client只返回校验后的独立Host数据。
  - [x] 3.1 写Host success/partial/empty/failed判别、failed不能total0、缺Zone/负数/重复Host/空total/200errors测试；运行 `npm test -- test/unit/domain/host-analysis.test.ts test/unit/clients/cloudflare-graphql-schema.test.ts` 先RED，再添加Zod DTO/响应Schema至GREEN。
  - [x] 3.2 基于任务1已核验Schema在GraphQL集成测试断言发现2aliases、Host7aliases、samples1node，每个Host的filter与窗口/limit一致；运行 `npm test -- test/integration/cloudflare-graphql-client.test.ts` 先RED，再实现两个Client操作至GREEN；实体仅通过variables传递，禁止拼入query。
  - [x] 3.3 测试聚合失败不请求该Host样本、样本响应混入其他/缺Host为sample失败、聚合成功保留、单次timeout/429/5xx上限、401/Schema/errors无重试；同命令先RED再GREEN，每次失败的窗口与Host变量深相等。
  - [x] 3.4 使用Mock时钟/AbortSignal验证90秒总预算包含响应体和退避、到期取消在途、无后续请求；同集成命令先RED再GREEN，验证每次attempt超时不超过remaining，不通过扩大每Host预算绕过总截止。

## 4. WAF 编排、统计、规则与覆盖

文件：`src/analyzers/waf-analyzer.ts`、`src/analysis/normalizer.ts`、`src/analysis/statistics.ts`、`src/analysis/rules.ts`、`src/domain/statistics.ts`、`src/domain/finding.ts`；测试 `test/unit/analyzers/waf-analyzer.test.ts`、`test/unit/analysis/normalizer.test.ts`、`statistics.test.ts`、`rules.test.ts`，新增 `test/fixtures/host-analysis.ts`。

接口：`calculateStatistics(StatisticsInput)`复用纯数学函数；`analysis/host-analysis.ts` 的 `analyzeHost(collection, zoneTotalEvents, analysisWindow, rulesConfig)` 组织独立统计、质量和hostId归属；`evaluateRules`保留原阈值算法；`calculateRuleAttention`返回程序关注等级；`analyzeWafAlert`是新Host编排的同一导出，不保留旧执行链。

- [x] 4. Host结果与分母隔离且失败可独立观察。
  - [x] 4.1 写同Path300/30、Host600/300、Zone1000、不同IP/ASN/Action的虚构夹具；统计/规则测试断言50%/10%、UA6/10、rate600/1860、Payload9999不影响；运行 `npm test -- test/unit/analysis/statistics.test.ts test/unit/analysis/rules.test.ts test/unit/analysis/normalizer.test.ts` 先RED，再最小修改纯函数至GREEN。
  - [x] 4.2 补零秒窗口、0事件、非空UA/null/空白、Top截断、sum超分母、Action/Source等于limit/和不相等、Unknown/LOW/HIGH/Bot前置资格测试；同命令先RED再GREEN，不能归一/clamp或用block单独抬等级。
  - [x] 4.3 Analyzer测试覆盖1/3/5Host、并列排序、null/空Host、发现10条截断、不补位失败Host、两工作通道并发最大2；运行 `npm test -- test/unit/analyzers/waf-analyzer.test.ts` 先RED，再编排两个Client操作至GREEN，统计/规则每个成功Host恰好一次。
  - [x] 4.4 同Analyzer测试加入正常coverage90%、一Host失败60%、sample失败仍可计、600变610覆盖null、Zone0不适用、全部失败与全部无有效Host；同命令RED/GREEN，验收为实际已分析数/失败/质量状态可解释且无虚构Host总数。

## 5. Catalog 命名空间与支持验证

文件：`src/domain/evidence-catalog.ts`、`src/analysis/evidence-catalog.ts`、`src/analysis/evidence.ts`及新增 `src/domain/host-evidence.ts`、`src/analysis/host-evidence.ts`；测试包含原有目录/支持策略回归及 `test/unit/analysis/host-evidence.test.ts`。

接口：`buildHostEvidenceCatalog`消费Host分析集合生成v2；`validateHostAIAnalysis`先校验完整命名空间、分母/分子和依赖，再复用 `validateAIAnalysisEvidence` 的纯支持策略，返回绑定相同v2目录的品牌/冻结结果。独立程序规则等级不依赖AI结果。

- [x] 5. 目录与每条声明有不可混用的Host及分母。
  - [x] 5.1 写稳定h0/h1 ID、明确owner、Zone证据隔离、Host/UA/窗口分母一致性、sampleHost校验测试；运行 `npm test -- test/unit/domain/evidence-catalog.test.ts test/unit/analysis/evidence-catalog.test.ts` 先RED，再实现v2 Schema/投影至GREEN，禁止复制当前只比较实体的弱一致性检查。
  - [x] 5.2 加入每Host64项/10KiB、总328项/56KiB、单值2048/2049、闭包裁剪、单Hostcontext超限与根失败测试；同命令RED/GREEN，检查ID不重编号、目录裁剪不改变UA分母且catalogComplete/riskAssessable准确。
  - [x] 5.3 写h0引用h1、Host引用Zone total、错误stat/Finding、独立ASN+Path拼关系、样本冒充总体、跨Incident品牌复用反例；运行 `npm test -- test/unit/analysis/evidence.test.ts` 先RED再支持验证GREEN，单Host整体拒绝而非忽略坏结论。
  - [x] 5.4 保留并扩展现有Bot9/10、UA/rate high、confidence0/0.6/超界、CRITICAL/Brute Force拒绝、Unknown空引用及最高风险不可挑低测试；同命令RED/GREEN，验收为攻击边界未放宽且合法单条样本仍有限展示。

## 6. 多 Host AI 契约与局部降级

文件：`src/domain/ai-analysis.ts`、`src/clients/llm.ts`、`src/clients/contracts.ts`、`src/analysis/ai-analyzer.ts`、`src/observability/ai-diagnostics.ts`；测试 `test/unit/domain/structured-ai.test.ts`、`test/integration/llm-client.test.ts`、`test/unit/analysis/ai-analyzer.test.ts`、`test/fixtures/structured-ai.ts`及`test/fixtures/llm/valid-output.json`。

接口：严格 `MultiHostAIWireSchema` v3和嵌套 `HostAIAnalysisWireSchema`；Client返回受控外层与按hostId成功/结构失败结果，不把raw未知字段交给Formatter；runAIAnalysis返回每Host available/unavailable及总体available/partial/unavailable。`valid-output.json` 为v3；旧单Host数据仅作为 `single-host-policy-output.json` 的内部策略夹具。

- [x] 6. 一个逻辑AI调用支持多Host安全结果。
  - [x] 6.1 写严格根/Host结构、最大5Host、每Host3观察/2建议、未知自由字段、旧v2拒绝、Provider Schema同源测试；运行 `npm test -- test/unit/domain/structured-ai.test.ts test/integration/llm-client.test.ts` 先RED，再修改Schema/Client协议至GREEN，wire snake_case映射后内部camelCase。
  - [x] 6.2 写根错全体降级、已知唯一Host局部字段错/跨引用只降级该Host、缺Host局部降级、重复/未知/无ID全体降级；运行 `npm test -- test/unit/analysis/ai-analyzer.test.ts test/integration/llm-client.test.ts` 先RED，再按design隔离至GREEN。
  - [x] 6.3 写messages64KiB/body96KiB/content32KiB/response128KiB边界、截断/refusal/非JSON、429/503最多两HTTP且同总超时、零合格Host不调用；同命令RED/GREEN，超预算不新增模型调用或修复prompt，安全诊断只白名单。

## 7. 单条通知与不可表示输入

文件：`src/notification/formatter.ts` 导出统一入口，`host-formatter.ts`、`templates.ts`、`blocks.ts` 分离布局/纯模板/预算；`src/config/dependencies.ts` 设置默认Top限制。测试为 `test/unit/notification/formatter.test.ts`、`host-formatter.test.ts`、`blocks.test.ts` 和四类 `test/fixtures/host-notifications.ts`。

接口：`formatWeComMessage`消费Host snapshot与已验证AI集合；`assembleBlocks`为小型纯预算函数。Formatter成功返回string；最小消息不可表示返回受控结果或抛稳定本地AppError，由任务8捕获为notification_failed且ack，不能抛至Queue重试层。

- [x] 7. 通知顺序、事实与2000字节边界可证明。
  - [x] 7.1 将design四类示例转为虚构完整输入fixtures，补HIGH/MEDIUM/Unknown/LOW排序、同级并列、中文一位小数、先防护/后来源目标/再集中建议、无重复摘要/Evidence测试；运行 `npm test -- test/unit/notification/formatter.test.ts` 先RED再模板GREEN。
  - [x] 7.2 写精确全block与99.96%显示100.0%反例、Source分布不完整、Unknown/LOW/Bot必要限定语、sample失败/局部AI降级测试；同命令RED/GREEN，禁止“全部攻击已阻止”、独立ASN访问Path等断言。
  - [x] 7.3 写1..5Host最小块保留、公平预算、IP/Path3与Country/ASN1上限、标题与正文不可拆、明细整项省略、控制符转义/多字节1999/2000/2001测试；运行 `npm test -- test/unit/notification/blocks.test.ts test/unit/notification/formatter.test.ts` 先RED，再实现blocks与接入至GREEN。
  - [x] 7.4 写两个128bytes ID加5Host、超长Host/Zone占位、历史超长ID与极小maxLength受控不可表示、无空字符串发送测试；同命令RED/GREEN，完整ID与窗口不被裁切，常规合法最长输入可容纳。

## 8. Pipeline、安全日志与 Workers 全链路

文件：`src/pipeline/process-alert.ts`、`src/pipeline/queue-handler.ts`、`src/config/dependencies.ts`、`src/observability/errors.ts`、`src/observability/logger.ts`、`src/observability/ai-diagnostics.ts`；测试 `test/integration/full-pipeline.test.ts`、`structured-evidence-pipeline.test.ts`、`failure-matrix.test.ts`、`queue-handler.test.ts`、`log-redaction.test.ts`及对应单元消费者。

- [x] 8. 所有阶段失败不越界重放且安全可观测。
  - [x] 8.1 在full-pipeline/structured-evidence-pipeline写H=3时7 GraphQL/1 LLM/1 WeCom、每Host统计与规则一次、所有变量同窗口、Queue ack=1/retry=0；运行 `npm test -- test/integration/full-pipeline.test.ts test/integration/structured-evidence-pipeline.test.ts` 先RED，再接入DTO/状态映射至GREEN。
  - [x] 8.2 failure-matrix/queue-handler加入Host aggregate失败、sample失败、单HostAI错/整体错、90秒截止、不可表示通知、企微2次重试只同文本、通知失败仍ack及成功后logger异常；运行 `npm test -- test/integration/failure-matrix.test.ts test/integration/queue-handler.test.ts` 先RED再GREEN，不新增任何上游重算。
  - [x] 8.3 log-redaction及ai-diagnostics测试加入Host实体/恶意键/引用ID/原文/Prompt/Secret哨兵、h0归属与实际请求计数；运行 `npm test -- test/integration/log-redaction.test.ts test/unit/observability` 先RED再白名单GREEN，目录错误不归Provider、结构/引用/支持失败仍可区分。
  - [x] 8.4 更新 `test/fixtures/domain.ts` 和已有使用旧Snapshot/Client接口的单元Mock；运行 `npm run typecheck`、`npm test` 全量至GREEN，保留Workers插件，无真实Fetch探测或live测试。

## 9. 运行文档与完整验收

文件：`README.md`、`docs/llm-model-compatibility.md`、`docs/deployment-verification.md`、`docs/release-checklist.md`、`wrangler.jsonc`（仅业务配置）、本Change新增 `verification.md`；不改历史需求备份或其他Changes。

- [x] 9. 已实施结果与全部契约一致后形成可审阅验收记录。
  - [x] 9.1 文档/非敏感配置写hostLimit、样本含义、请求预算、coverage未知、采样限制、Catalog2/AI3、局部降级、ID边界、旧Queue与整包回滚；运行 `rg -n 'hostLimit|schema_version|128|回滚|覆盖' README.md docs/llm-model-compatibility.md docs/deployment-verification.md docs/release-checklist.md wrangler.jsonc` 核对与design一致，不把候选远端验证标为完成。
  - [x] 9.2 运行下列质量命令并在verification.md记录实际结果；bindings未变化不必types，若经批准改变bindings则额外 `npm run types`。验收为typecheck/lint/Workers test/本地dry-run/严格与工作流校验通过，未部署、未调用真实LLM/企微；任务1单独授权的Cloudflare只读核验另记。
  - [x] 9.3 刷新GitNexus后运行 `gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer`，比较设计范围并复核HIGH/CRITICAL调用方；运行 `git diff --check`、仅对变更文件检查凭证哨兵/原文日志，验收为无意外生产文件/资源/Secret变更。
  - [x] 9.4 对照本delta每个Scenario逐项映射测试/验证证据，全部完成后才记录implemented；真实非生产Provider/企微/部署单独授权，主Specs同步/归档另待指令，不能因离线测试通过而声称线上验收。

## 核心失败断言示例

以下为实施测试的核心断言示例；实际测试与结果见verification.md。夹具使用 `makeNotificationFixture`、`rulesConfig`；下列断言与实际Host接口一致。

```typescript
const fixture = makeNotificationFixture("normal");
const hosts = fixture.collections.map((host) =>
  analyzeHost(host, fixture.discovery.zoneTotalEvents, fixture.message.analysisWindow, rulesConfig),
);
expect(hosts[0]?.statistics?.topPath?.ratio).toBe(50);
expect(hosts[1]?.statistics?.topPath?.ratio).toBe(10);
expect(hosts[0]?.statistics?.userAgentConcentration?.ratio).toBe(60);
expect(hosts[0]?.statistics?.requestRatePerSecond).toBeCloseTo(600 / 1860);
const catalog = buildHostEvidenceCatalog({
  message: fixture.message, zoneTotalEvents: fixture.discovery.zoneTotalEvents, hosts,
});
expect(() => validateHostAIAnalysis({
  host_id: "h0",
  risk: { level: "Unknown", evidence_ids: [] },
  attack: { type: "Unknown", confidence: 0, evidence_ids: [] },
  observations: [],
  recommendations: [{ kind: "review_source", evidence_ids: ["h1:agg:ip:0"] }],
}, catalog)).toThrow(expect.objectContaining({ code: "ai_reference_invalid" }));
```

## 验证命令

实际执行及结果以verification.md为准。类型生成和dry-run关闭dotenv加载；Vitest配置固定禁止读取本地.env，全部测试使用虚构bindings与Mock。真实模型/企微及远端部署不在本轮验收范围。

## 2026-09-29 通知排版追加任务

- [x] 11. AI建议归属展示：在test/unit/notification/formatter.test.ts先复现2项失败，再修改src/notification/host-formatter.ts；已校验模型建议独立为AI分析处理建议，固定Dashboard和降级提示不冒充AI。验收命令 `npm test -- test/unit/notification test/integration/host-pipeline.test.ts` 为38项通过，typecheck/lint/严格校验通过；同步design、delta和verification。

用户明确要求中文Host序号、维度标签换行、隐藏等级展示与Dashboard链接，覆盖本文件早期任务中相应展示要求，内部规则不变。

- [x] 10. 按用户新格式完成通知展示和验证，下列子任务全部通过。
- [x] 10.1 在test/unit/notification先补排版失败断言，再修改src/notification/host-formatter.ts；验收为1至5 Host编号、同类明细分组、无等级文案、URL回退及无空标题，运行 `npm test -- test/unit/notification test/integration/host-pipeline.test.ts`。
- [x] 10.2 同步本Change展示契约、示例和验证记录；运行typecheck、lint、全部Mock测试、OpenSpec严格/工作流及GitNexus范围检查，不重发真实通知或部署。

```bash
openspec validate host-scoped-alert-analysis --strict
python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/host-scoped-alert-analysis
npm run typecheck
npm run lint
npm test
npx wrangler deploy --dry-run --outdir /tmp/host-scoped-alert-analysis-dry-run
gitnexus status
gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer
git diff --check
```
