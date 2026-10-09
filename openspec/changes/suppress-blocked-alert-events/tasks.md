# 实施任务：已拦截事件静默

> 后续实施使用 superpowers:executing-plans，按本文件逐项推进。用户于2026-10-09确认实施，当前 status=approved；任务1.1/1.4已完成，1.2/1.3按新批准的运行时守卫和API证据验收，详见verification.md；本文不新增勾选。

**Goal:** 精确过滤block且在有效、内部一致的全Zone固定窗口聚合观察零时静默，失败保守通知。

**Architecture:** 同窗口发现阶段先过滤，再选有限Host。纯函数决定静默/原始空/继续/降级，Pipeline在LLM和通知之前处理独立静默终态。

**Tech Stack:** TypeScript strict、Workers、Queues、Fetch、Zod、Wrangler、Vitest及`@cloudflare/vitest-plugin`、ESLint、npm；不新增依赖。

## 全局约束

- 固定策略 `exclude-exact-block-v1`；不新增env开关/Queue字段。新旧v1消息使用原窗口、hostLimit/sampleLimit快照。
- 仅精确 `block` 排除，未知/缺失/大小写变体不默认block。不区分规则来源，不查IP黑名单。
- 所有待关注数据先过滤再选Host，raw仅上下文；禁止独立采样结果相减，采用observationBasis=adaptive_aggregate并保留采样风险说明；有效且内部一致的聚合零允许静默，接受稀少非block遗漏。
- H默认3、1..5；样本默认50、最大100；GraphQL正常1+2H HTTP、4+8H node selections，最多33 HTTP尝试/132 nodes；最大并发2，整个采集90秒。
- Catalog2/AI3及已有证据归属、支持校验、Bot门槛、局部降级、所有预算保持；通知不超过2000 UTF-8 bytes。
- 全部测试只用虚构/脱敏夹具和Fetch Mock，不运行live模型/企微，不部署、不写Secrets或Cloudflare资源；后续提交/合并/同步/归档也需用户指令。
- 每个行为任务先补失败测试，运行并确认因行为缺失而RED，再最小实现至GREEN，不用未核验GraphQL字段填补计划。

## 任务

依次完成能力与影响门禁、领域契约、过滤查询、分析证据、通知和全链路验证；门禁不足的任务保持未完成，不以Mock代替外部能力证据。

## 1. 审批、能力和影响门禁

- [x] 1. 审批、能力和图影响门禁均有证据，所有子项完成后通过。

- [x] 1.1 取得用户对本proposal/design/delta/tasks及已接受采样风险的观察策略的明确确认后才记录approved；运行工作流及OpenSpec严格校验，结果记录本Change后续新增 `verification.md`，未批准不进入代码任务。
- [x] 1.2 验收两dataset已核验action_neq/精确比较/AND/OR/字段/settings及最终四alias API证据，并在现有 `test/fixtures/graphql/blocked-action-schema-contract.json` 保留日期、方法和限制。实现并对抗测试rawActions运行时守卫：limit20截断、重复分类、不安全加总、sum!=raw、非block sum!=attention、正计数null/缺失/空串分类全部在Host/AI前降级。null查询实际不支持且底层null保留未证实，验收不再要求不可实现的null查询或无数据对照；守卫不依赖该保证，不放宽未知保留语义。
- [x] 1.3 验收observationBasis=adaptive_aggregate及标准化计算的质量映射、最终四alias原始Action直接block来源、过滤先于TopN的Mock对抗测试与真实目标形状/settings预算证据；记录booya.mx指定窗口raw378/attention[]/rawActions block378/topHosts[]及非空混合样本尚无实测限制。用户接受稀少非block采样遗漏；不要求完整覆盖证明，采样未知本身不降级。
- [x] 1.4 刷新GitNexus（保留AGENTS/skills），对下列公共符号执行impact/context并按源码核对调用方；记录风险和范围，HIGH/CRITICAL或额外范围先回到OpenSpec确认。验收为图索引与实际实施分支一致且风险处置记录齐全。

```bash
gitnexus status
gitnexus analyze --branch feat/suppress-blocked-alert-events --name cloudflare-ai-alert-analyzer --skip-agents-md --skip-skills
gitnexus impact ZoneDiscoverySchema --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact discoverZone --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact collectHostSnapshot --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact analyzeHostWafAlert --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact calculateStatistics --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact buildHostEvidenceCatalog --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact processHostAlert --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
gitnexus impact formatHostWeComMessage --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
```

## 2. 领域契约和静默纯函数

新增 `src/domain/event-scope.ts`、`src/analysis/suppression.ts`及两个对应单元测试，纯判定夹具内联于测试。`src/domain/host-analysis.ts`、`src/domain/analysis-result.ts`及供集成共享的 `test/fixtures/blocked-events.ts` 随任务4/7接入；能力守卫及全链路验收尚待实施验证，父任务2保持未完成，不将孤立模块视为全链路静默已生效。

接口：Zod推导 `ScopedDiscovery` 与 `SuppressionDecision`；`decideSuppression(discovery: ScopedDiscovery): SuppressionDecision` 返回 `kind=suppress|raw_empty|continue|degrade`。精确字段按design数据契约；新增结果变体不能伪造Incident。

- [x] 2. 领域与纯函数四种结果通过本组单元测试。

- [x] 2.1 写表驱动失败测试：raw100/attention0/block100、adaptive_aggregate/comparable、topHosts空得到suppress；换sampled或sampling unknown仍suppress；缺必需计数、block99、topHost正及不完整/不可判定rawActions分别degrade；全零raw_empty；attention1继续。运行本组测试确认RED。
- [x] 2.2 最小实现Schema及纯函数，验证安全整数/null/重复Host/缺标识不默认零，全部本组测试GREEN；明确HTTP/GraphQL错误先在Client边界拒绝，不由纯函数猜测原始响应。
- [x] 2.3 补充99.96%显示100.0%、TopN不完整、仅raw/blocked两个采样计数相等而attention未知、全Host空但attention>0、原始0但attention>0冲突等反例，先RED再GREEN；验收为协议缺失或已知矛盾不能suppress；三计数一致的Adaptive观察零可suppress。

```bash
npm test -- test/unit/domain/event-scope.test.ts test/unit/analysis/suppression.test.ts
```

示例断言（在任务2定义的夹具中分别构造完整合法ScopedDiscovery）：

```typescript
expect(decideSuppression(eligibleAllBlocked).kind).toBe("suppress");
expect(decideSuppression(sampledZero).kind).toBe("suppress");
expect(decideSuppression(rawEmpty).kind).toBe("raw_empty");
expect(decideSuppression(mixedActions).kind).toBe("continue");
```

## 3. GraphQL过滤与响应质量

修改 `src/clients/cloudflare-graphql.ts`、`src/clients/cloudflare-graphql-schema.ts`、`src/clients/contracts.ts`、`src/domain/incident.ts`，更新 `test/unit/clients/cloudflare-graphql-schema.test.ts`、`test/integration/host-graphql-client.test.ts`；新增 `test/integration/blocked-graphql-client.test.ts`。接口：`discoverZone`返回ScopedDiscovery；`SnapshotCollectionInput`贯通固定scope/policy，Host返回同scope集合。

- [x] 3. 同范围查询、质量解析和预算通过本组Mock集成测试。

- [x] 3.1 门禁通过后按核验的真实query语法写Fetch Mock失败测试，断言发现4 alias中rawTotal/rawActions均无Action谓词、rawActions按Action分组limit20/count_DESC、attention与TopHost同action_neq:block谓词，Host7聚合和样本同谓词/Host/窗口；原Top10均block时非block Host进入排名。运行本组确认RED。
- [x] 3.2 最小修改查询和响应解析至GREEN，显式校验所有alias和质量元数据；验证不猜字段、不以 `?? 0` 掩盖缺失、不依赖Action枚举白名单、不拼接Host/Zone实体；正常H=3为7 HTTP/28 nodes，H=5为11/44。
- [x] 3.3 先写HTTP200 errors、缺alias/null/负数/不安全整数、过滤聚合含block、样本混入block、未知/缺失Action及语义合法空数组测试，RED后实现分类至GREEN；样本污染整组不可用但可信聚合保留，绝不据样本判断静默。
- [x] 3.4 先写timeout/429/5xx有限重试、401/Schema/过滤不支持不重试、90秒取消且不发后续请求测试，RED后接入预算至GREEN；重试变量深相等，无新增质量探测请求或第二轮追踪。

```bash
npm test -- test/unit/clients/cloudflare-graphql-schema.test.ts test/integration/host-graphql-client.test.ts test/integration/blocked-graphql-client.test.ts
```

## 4. Analyzer、统计、规则与覆盖

修改 `src/analyzers/waf-analyzer.ts`、`src/analysis/host-analysis.ts`、`src/analysis/statistics.ts`、`src/analysis/normalizer.ts`、`src/analysis/rules.ts`及 `src/domain/statistics.ts`。测试 `test/unit/analyzers/waf-analyzer.test.ts`、`test/unit/analysis/host-statistics.test.ts`、`test/unit/analysis/statistics.test.ts`、`test/unit/analysis/rules.test.ts`、`test/unit/analysis/normalizer.test.ts`（缺失的测试文件新建）。

- [x] 4. Host选择、统计和规则通过同范围回归测试。

- [x] 4.1 补过滤前后排名、自定义/托管来源混合、同IP双Action、未知Host、Host细查零与发现正不一致的失败测试；确认RED后在selectHosts前调用decideSuppression，验证suppress/empty/degrade不调用Host采集，attention>0才继续且失败不补位。
- [x] 4.2 建raw1000/block900/attention100、Host60与40、各HostTopIP30与10的虚构夹具；RED后验证Host集中度50%/25%、zoneShare60%/40%、覆盖100%，分母不得1000；Action/Source/samples/Findings全部同scope。
- [x] 4.3 补BLOCK与block空白变体不计block、UA过滤后非空分母、窗口速率、计数不可比较/Action或Source不完整比例null的失败测试，RED后修正精确Action语义及必要质量映射，全部本组测试GREEN。

```bash
npm test -- test/unit/analyzers/waf-analyzer.test.ts test/unit/analysis/host-statistics.test.ts test/unit/analysis/statistics.test.ts test/unit/analysis/rules.test.ts test/unit/analysis/normalizer.test.ts
```

## 5. Evidence与AI边界

修改 `src/domain/host-evidence.ts`、`src/analysis/host-evidence.ts`、`src/analysis/evidence-catalog.ts`、`src/analysis/evidence.ts`、`src/analysis/ai-analyzer.ts`、`src/clients/llm.ts`；测试 `test/unit/analysis/host-evidence.test.ts`、`test/unit/analysis/evidence.test.ts`、`test/unit/analysis/ai-analyzer.test.ts`、`test/integration/host-llm-client.test.ts`，更新 `test/fixtures/host-ai.ts`。Schema输出仍AI3，内部Catalog2同包携带scope/policy。

- [x] 5. Evidence与AI边界通过支持校验和局部降级测试。

- [x] 5.1 RED测试过滤范围/策略缺失或错配、Host引用raw总量、block-only IP生成review_source、BLOCK数值误分类，最小更新来源校验及Catalog至GREEN；同IP合法剩余事件仍可引用，block上下文不进入可引用目录。
- [x] 5.2 RED测试suppressed/raw_empty/质量降级零LLM、混合事件单逻辑LLM、跨Host/错误分母拒绝及一Host坏输出仅局部降级，最小接入至GREEN；不增加模型修复重试、每Host独立调用或自由文本输出。
- [x] 5.3 更新prompt受控scope说明及相关Mock，在同组验证非block不证明到源站，Bot门槛、证据预算和LLM输入/输出字节限制均不放宽，测试GREEN。

```bash
npm test -- test/unit/analysis/host-evidence.test.ts test/unit/analysis/evidence.test.ts test/unit/analysis/ai-analyzer.test.ts test/integration/host-llm-client.test.ts
```

## 6. 通知文案和字节预算

修改 `src/notification/host-formatter.ts`、`src/notification/templates.ts`，必要时 `src/notification/blocks.ts`；测试 `test/unit/notification/formatter.test.ts`、`test/unit/notification/blocks.test.ts`，更新 `test/fixtures/host-notifications.ts`。

- [x] 6. 通知语义及字节边界通过本组测试。

- [x] 6.1 写混合、原始空、过滤失败、必需计数缺失四类文案失败测试；RED后改为待关注范围说明/处理分布，原始上下文明确标签，失败无未过滤明细，所有过滤后选中Host保留状态，旧“全block防护详情”不再出现。
- [x] 6.2 写被过滤IP不产生建议、未知/非block不等于成功、必要限定语保留、五Host+128bytes双ID+中文/emoji的1999/2000/2001边界测试；RED后调整完整区块预算至GREEN，不隐藏失败块或截断完整ID，不能表示时沿用受控notification_failed。

```bash
npm test -- test/unit/notification/formatter.test.ts test/unit/notification/blocks.test.ts
```

## 7. Pipeline、日志与Workers全链路

修改 `src/pipeline/process-alert.ts`、`src/observability/errors.ts`、`src/observability/logger.ts`，必要时依赖类型接入 `src/config/dependencies.ts`；保持 `src/pipeline/queue-handler.ts` ack/retry语义。新增 `test/integration/blocked-events-pipeline.test.ts`，扩展 `test/integration/host-pipeline.test.ts`、`test/integration/queue-handler.test.ts`、`test/integration/failure-matrix.test.ts`、`test/integration/log-redaction.test.ts`、`test/integration/cloudflare-alert-route.test.ts`及 `test/unit/domain/queue-message.test.ts`。

- [x] 7. Workers全链路通过矩阵和ack/retry断言。

- [x] 7.1 使用Workers插件写全Zone聚合观察零符合门槛输入LLM0/企微0/Formatter0、status=suppressed、ack1/retry0的失败测试；RED后在Pipeline先返回独立静默结果，验证绝不记录notification_sent或response_category=success。
- [x] 7.2 对info/warn/error日志方法抛错写失败测试，RED后best-effort静默日志至GREEN；日志包含no_attention_events_observed、observationBasis=adaptive_aggregate与采样风险说明、policy/scope、已校验计数及质量、ID、窗口，请求数，queue_attempt可按ID关联，不含样本/原始响应/Secret哨兵。
- [x] 7.3 在Workers Fetch Mock覆盖本文件验收矩阵全部场景；保留企微重试同文本不上游重放、LLM局部降级、GraphQL固定窗口、成功后日志抛错、发送失败ack等回归，RED后接入并GREEN。
- [x] 7.4 新旧合法v1 Queue夹具均应用相同固定策略，不改window/configSnapshot/schemaVersion；入口仍只校验/入队202、入队失败不成功。运行本组确认无GraphQL/LLM/WeCom进入fetch路径，并记录回滚旧包可读同消息的源码依据。

```bash
npm test -- test/integration/blocked-events-pipeline.test.ts test/integration/host-pipeline.test.ts test/integration/queue-handler.test.ts test/integration/failure-matrix.test.ts test/integration/log-redaction.test.ts test/integration/cloudflare-alert-route.test.ts test/unit/domain/queue-message.test.ts
```

## 8. 文档、完整验证与交付门禁

未来修改 `README.md`、`docs/deployment-verification.md`、`docs/release-checklist.md`，本Change新增 `verification.md`；不改历史备份或其他Changes。

- [x] 8. 完整质量检查与验收记录通过，外部门禁未完成不得完成。

- [x] 8.1 记录过滤口径、Adaptive观察策略与明确接受的稀少非block遗漏风险、原始空/静默/失败区别、无新增配置、旧消息和整包回滚、请求预算及日志语义；用文档与实际Schema/请求测试逐项对照，不能声称未做的API核验或线上验证已通过。
- [x] 8.2 执行下方typecheck/lint/完整Workers test及本地Wrangler dry-run、OpenSpec严格/工作流验证；若bindings经另行确认发生变化额外types，当前计划不改bindings。verification记录新鲜输出和每个Scenario的测试映射，失败修复后再报告。
- [x] 8.3 刷新GitNexus并执行detect-changes --scope all，与设计范围比较；运行git diff --check及变更内容凭证检查，复核HIGH/CRITICAL调用方与测试，未覆盖范围先修订确认，不以纯文本搜索声称完成图检查。
- [x] 8.4 核验矩阵与所有任务完成后才报告implemented；外部能力门禁未通过不得勾选。主Specs同步/归档前必须另获授权建立前序MVP与Host能力基线，再应用本delta；本任务只记录该依赖，不自行同步、归档、提交、合并或部署。

## 验收矩阵

| 场景 | 任务/可观察结果 |
|---|---|
| 自定义和托管block | 3、4、7：均排除，不查询规则或IP名单 |
| 全Zone聚合观察零符合门槛 | 2、7：LLM0/企微0/ack1/retry0，独立suppressed日志 |
| block与非block混合 | 3、4、5、7：所有维度、样本、分母与证据scope一致 |
| 原Top Host全block、其他Host非block | 3、4：查询过滤先于排名，其他Host能入选 |
| 同IP含block和其他Action | 4、5：剩余事件继续，可引用其独立证据 |
| 缺失/未知/大小写Action | 2、3、4：不误归block或零；不可可靠保留则Host/AI前降级 |
| 查询失败/无效/聚合不一致/关键缺失 | 2、3、7：明确降级，不静默 |
| 样本全block但聚合非block正 | 3、7：样本失败、聚合保留，整条不静默 |
| 原始空与聚合观察零静默 | 2、6、7：empty通知与suppressed无通知可区分 |
| 静默日志失败 | 7：仍ack，无主动重放和发送成功日志 |
| 有效且一致的采样零/采样未知零 | 2、3、7：suppress，不宣称统计完整性 |
| 仅采样数相等/舍入100.0%/TopN | 2、3、7：缺少完整必需聚合条件时不得静默 |
| 固定窗口/旧消息/重试/局部LLM失败 | 5、7：窗口不变、同文本重试、不重跑上游 |
| 发送成功后日志异常 | 7：保持sent并ack |
| 通知范围/必要说明/2000bytes | 6：明细无block，语义和ID完整 |

## 验证命令

以下质量命令已完成，实际结果见verification.md。bindings未变，types不适用。dry-run和types禁止加载真实dotenv，不执行deploy或live测试。

```bash
python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/suppress-blocked-alert-events
openspec validate suppress-blocked-alert-events --strict
npm run typecheck
npm run lint
npm test
CLOUDFLARE_LOAD_DOT_ENV=false npx wrangler deploy --dry-run --outdir /tmp/suppress-blocked-alert-events-dry-run
# 仅bindings确实改变时执行：
CLOUDFLARE_LOAD_DOT_ENV=false npm run types
gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer --branch feat/suppress-blocked-alert-events
git diff --check
```

## 运行时Action保留守卫（2026-10-09已授权细化）

发现 MUST 使用固定四alias：无Action过滤的 `rawTotal`、无Action过滤且按Action分组/`count_DESC`排序/limit20的 `rawActions`、`action_neq:"block"` 的 `attentionTotal` 和同谓词 `topHosts`。完整原始Action分布中的精确 `block` 分类直接提供 `blockedTotalEvents`，不得用raw-attention相减；完整分布无block分类时该直接计数为0，分布不完整时为null。运行时先验证分布未触及limit20、分类无重复、计数及加总均为安全非负整数、分类和等于rawTotal、非block分类和等于attentionTotal，且无正计数null/缺失/空串分类。任一条件不足 MUST 在Host采集和AI前保守降级，不依赖action_neq保留底层null的保证；这些相等仅是观察一致性检查，不证明统计完整性。GraphQL errors、缺alias、null响应或协议无效为collection_failed，不把失败当零。未知非空字符串、BLOCK和带空白的block为非block；无法可靠保留不可判定Action则基础降级通知、零AI。

该设计实现用户新确认的null/缺失/空串不得默认block、无法可靠保留则降级，未放宽未知Action语义。正常预算保持1+2H HTTP、4+8H nodes（H=5为11/44；最多两次技术重试33/132），无额外探测轮次。Host聚合/样本必须携带policyId和eventScope=attention；Catalog同样必须有范围标记。观察元数据由边界标准化及结果构建计算，不能信任Client输入声明。可靠范围下样本/Host Action的null或缺失可标准化为unknown并保留有效信息；精确block样本污染只使样本集合失败、可信聚合保留，精确block聚合污染使Host聚合失败。
