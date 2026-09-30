# 实施任务：结构化证据引用

> 使用 `superpowers:executing-plans` 按编号推进；先获得本 Change 的明确确认，再执行实现。此清单完成不意味着获准提交、同步、归档或部署。

## 目标与架构

以现有 Incident/Statistics/Findings 派生目录，LLM 只返回受控类型和引用，统一领域校验后由模板生成通知。沿用 TypeScript strict、Workers、Fetch、Zod 4、现有 Workers Vitest 插件和 npm；不新增运行时依赖。

全局约束：Catalog v1 / AI v2；100 项、128 KiB、单值 2048 bytes；观察至多 6、建议 1..3、每节点引用至多 4；不改实体原义。每项实现须先新增失败测试并记录 RED，再最小实现并记录 GREEN；不得以更新旧快照代替断言。所有外部请求 mock。不得部署、写 Secret、修改云资源、改变统计算法/规则阈值/Queue 窗口或增加模型修复调用。

## 任务

- [x] 1. 确认设计与实施前影响范围
  - [x] 1.1 用户明确确认 proposal/specs/design/tasks 后才将状态改为 approved；运行下方两项 OpenSpec 校验，确认通过。
  - [x] 1.2 运行 GitNexus status，必要时以保护 AGENTS/skills 的参数刷新索引；对 AIAnalysisSchema、AIAnalysisClient、validateAIAnalysisEvidence、runAIAnalysis、formatWeComMessage、AppError、toExternalFailure、createLogger 及新增/变更公共符号做 impact/context，记录风险与实际源码调用方。design 已披露 AppError CRITICAL/29、toExternalFailure HIGH/4，用户确认 artifacts 同时确认该范围，不重复请求同一授权；出现新增超范围影响再确认。索引无法使用则先修复，不宣称高影响迁移门禁通过。
  - [x] 1.3 记录工作区差异并选择隔离工作区；核对本计划的生产文件范围和现有两个 Change 状态，确认没有擅自同步、归档或覆盖用户改动。

## 2. 有界目录

- [x] 2. 建立目录契约与纯函数
  - [x] 2.1 新建 `test/unit/analysis/evidence-catalog.test.ts`、`test/unit/domain/evidence-catalog.test.ts` 和 `test/fixtures/evidence-catalog.ts`；以 design 数据表写稳定 ID、原顺序索引、唯一性、每维 10/11、总量、2048/2049 UTF-8 bytes、128 KiB、null/空输入、Finding/stat 不一致、UA 原分母和依赖省略测试。运行 `npm test -- test/unit/analysis/evidence-catalog.test.ts test/unit/domain/evidence-catalog.test.ts` 确认缺少新能力导致 RED。
  - [x] 2.2 新建 `src/domain/evidence-catalog.ts` 和 `src/analysis/evidence-catalog.ts`，实现 `buildEvidenceCatalog(input: AIAnalysisInput): EvidenceCatalog`、判别联合 Schema、固定 ID、限额和完整性标识；再次运行同组测试至 GREEN。
  - [x] 2.3 为 `/index.php`、`WAF/API`、`ExampleClient/1.0`、中文 query、大小写不同路径、相同前缀不同实体加入逐字保真断言；确认省略整项而非截断、无新统计计算、时钟变化不改变结果。

## 3. 封闭模型契约

- [x] 3. 对齐 wire、本地和 Provider Schema
  - [x] 3.1 在 `test/unit/domain/analysis-models.test.ts` 和 `test/integration/llm-client.test.ts` 先写 v2、旧输出拒绝、所有层额外字段、非法枚举、confidence 边界、ID 长度/字符和数组上限测试；断言 Provider Schema 等于 Zod 导出结果；运行两文件确认 RED。
  - [x] 3.2 修改 `src/domain/ai-analysis.ts`，导出 `AIAnalysisWireSchema`（无 transform/refinement）及 camelCase `AIAnalysisSchema`，复用子 Schema；新增 `toAIAnalysis(wire): AIAnalysis` 边界映射与 `ValidatedAIAnalysis` 不透明只读类型。运行领域测试至 GREEN，不给未验证结果构造 available 的生产入口。
  - [x] 3.3 修改 `src/clients/llm.ts` 与 `src/clients/contracts.ts`，Client 输入变为 EvidenceCatalog；Prompt 说明每条支持规则，Provider Schema 由 `z.toJSONSchema(AIAnalysisWireSchema)` 生成；Client 只完成协议/结构校验和映射。保持原 token 配置、超时、length/refusal 优先级及 429/5xx 一次重试，运行 LLM 集成测试至 GREEN。

## 4. 支持规则和统一校验

- [x] 4. 替换正则机制并封闭绕过路径
  - [x] 4.1 在 `test/unit/analysis/evidence.test.ts` 对 design 支持表每一行添加通过/拒绝用例：不存在/重复引用、类型错误、缺少/无关证据、错误 Finding、真实引用无关结论、跨维度联结、样本总体混用、风险挑低等级、CRITICAL 和不支持攻击类型；运行该文件确认 RED。
  - [x] 4.2 修改 `src/analysis/evidence.ts` 实现 `validateAIAnalysisEvidence(analysis: AIAnalysis, catalog: EvidenceCatalog): ValidatedAIAnalysis`，固定验证顺序和错误优先级；深度只读绑定同一目录；删除 `extractedEntities`、实体集合、IP/path/ASN 及自动动作自然语言正则，运行支持矩阵至 GREEN。
  - [x] 4.3 为 Unknown 空引用/置信度 0、非 Unknown 空引用、partial/all-unknown 输入、Bot 9/10 UA 门槛及 0/0.6/>0.6 置信度添加 RED/GREEN 测试；确认所有类型精确遵循支持表，不引入宽松匹配。
  - [x] 4.4 在 `test/unit/analysis/ai-analyzer.test.ts` 先加入 mock Client 返回真实但不支持引用也失败、目录失败不调用 Client、空/采集失败不调用 LLM 的 RED 测试；修改 `src/analysis/ai-analyzer.ts` 统一生成目录、结构/支持校验及降级捕获，运行该文件至 GREEN。

## 5. 稳定错误和安全诊断

- [x] 5. 只传播受控诊断
  - [x] 5.1 在 `test/unit/observability/errors.test.ts`、`logger.test.ts` 和 `test/integration/log-redaction.test.ts` 先写每个 code/reason 和恶意 ID/字段名/finish_reason/Error/cause/凭证/实体哨兵断言；确认旧实现泄漏或缺分类的 RED。
  - [x] 5.2 修改 `src/observability/errors.ts`、`logger.ts`、`src/clients/llm.ts`、`src/analysis/ai-analyzer.ts` 及 `src/pipeline/process-alert.ts`，实现固定路径白名单、数组归一、reason、计数上限、finishReason 枚举、LocalAnalysisFailure 联合与本地日志投影。不得把未知路径直接 join 进日志，不再把语义错误重包为 ai_evidence_invalid，保留 GraphQL/WeCom 既有 ExternalFailure；运行上述测试至 GREEN。
  - [x] 5.3 确认 `runAIAnalysis` 的所有 catch 路径不携带 ZodError/原文，available/unavailable 的错误映射均受控；统计类诊断仍可查询，旧三种 Evidence 原因已从新路径移除；用 `rg` 和测试验证。

## 6. Formatter 全契约迁移

- [x] 6. 仅从程序值与模板生成通知
  - [x] 6.1 在 `test/unit/notification/formatter.test.ts` 写 RED：合法目录渲染、风险/攻击限定语、原关键信息完整、点号/URL/UA/中文/query 不变、自由文本扩展拒绝、跨目录结果不可组合、样本口径和联合关系边界。
  - [x] 6.2 修改 `src/notification/formatter.ts`，available 仅消费 ValidatedAIAnalysis，穷举 risk/attack/observations/recommendations 模板；summary 根据受控观察组合，事实区不依赖模型选取；保持规则降级；运行 Formatter 测试至 GREEN。
  - [x] 6.3 新增控制符/换行注入、超长实体整项省略、2000 UTF-8 bytes 与 maxLength 双界限、整条裁剪保留限定语的 RED/GREEN；确认不发半截事实、不丢正常身份和固定窗口。
  - [x] 6.4 更新 `test/fixtures/llm/valid-output.json`、`invented-output.json` 及领域/流程测试消费者；旧响应作为明确拒绝夹具保留。运行全部单元测试，确认不会通过类型断言伪造 ValidatedAIAnalysis 绕过校验。

## 7. Workers 全链路与回归

- [x] 7. 验证调用次数、降级和 Queue
  - [x] 7.1 在 `test/integration/failure-matrix.test.ts`、`full-pipeline.test.ts`、`queue-handler.test.ts` 先写 RED，覆盖每种 AI 输出/引用失败：collectSnapshot=1，聚合/样本 HTTP 各=1，LLM=1，统计/规则各=1，WeCom=1，ack=1/retry=0；窗口深比较原 Queue 值。
  - [x] 7.2 补齐目录失败和零数据 LLM=0、LLM 429/5xx 后非法输出 LLM=2、企微重试只重复同一通知、发送成功后 logger 抛错仍 ack；最小调整已列模块直至 GREEN，不修改 GraphQL 或 Queue 业务行为。
  - [x] 7.3 运行全量 `npm test`，验证路由、Payload、固定窗口、GraphQL、统计、规则、空数据、通知失败原测试仍通过；确认 Workers 插件仍生效且没有真实网络发送。

## 8. 文档和实施验收

- [x] 8. 完成质量与迁移交付
  - [x] 8.1 更新 `README.md`、`docs/llm-model-compatibility.md`、`docs/deployment-verification.md`、`docs/release-checklist.md`，说明 v2 支持边界、Provider 待实测、整包发布/回滚、旧版误报风险、Unknown 语义与未授权操作；核对示例全部虚构。
  - [x] 8.2 执行 typecheck、lint、test、OpenSpec 严格/工作流校验和本地 Wrangler dry-run，记录实际结果；bindings 未变则无需 types，若批准范围内变更则额外运行 types。
  - [x] 8.3 运行 `gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer`，逐项比对设计范围；HIGH/CRITICAL 需复核调用方/测试，新增超范围调用链再返回范围确认。检查 `git diff --check`、Credential 哨兵、生产源码中旧提取逻辑和模型文本展示入口已消失。
  - [x] 8.4 对照 design 测试矩阵及 spec 所有场景，记录验证证据与限制，全部通过才将状态设为 implemented。明确未部署/未写 Secret/未改资源；主 Specs 同步和归档等待单独指示。

## 关键测试断言示例

以下为实施时新增测试的核心断言，fixtures 使用任务 2 新建的虚构输入；不存在的导出/行为应先导致 RED，不能提前添加生产实现使其直接通过。

```typescript
const first = buildEvidenceCatalog(input);
const second = buildEvidenceCatalog(structuredClone(input));
expect(second).toEqual(first);
expect(new Set(first.entries.map((entry) => entry.id)).size).toBe(first.entries.length);
expect(first.entries.length).toBeLessThanOrEqual(100);

expect(() => validateAIAnalysisEvidence(unsupportedClaim, first)).toThrowError(
  expect.objectContaining({ code: "ai_claim_unsupported", retryable: false }),
);
expect(AIAnalysisWireSchema.safeParse({ ...validWireOutput, summary: "MODEL_SENTINEL" }).success).toBe(false);
expect(sentBody.response_format.json_schema.schema).toEqual(z.toJSONSchema(AIAnalysisWireSchema));
expect(logLines.join("\n")).not.toContain("MODEL_SENTINEL");
```

## 验证命令

```bash
npm run typecheck
npm run lint
npm test
npx wrangler deploy --dry-run --outdir /tmp/structured-evidence-references-dry-run
openspec validate structured-evidence-references --strict
python3 .agents/skills/openspec-superpowers-workflow/scripts/validate_openspec_workflow.py openspec/changes/structured-evidence-references
gitnexus status
gitnexus detect-changes --scope all --repo cloudflare-ai-alert-analyzer
git diff --check
```

GitNexus 索引必要时刷新：`gitnexus analyze --branch master --name cloudflare-ai-alert-analyzer --skip-agents-md --skip-skills`；若实施所在分支改变，使用实际分支名。以上质量命令属于确认后的实施验收，本轮 artifacts 校验不等于运行时实现验证。
