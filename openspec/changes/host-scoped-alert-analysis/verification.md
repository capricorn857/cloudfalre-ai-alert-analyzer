# 实施与验证记录

## 当前结果

后续建议来源标题调整：用户要求显式标明AI分析处理建议。Formatter将已校验模型建议与固定Dashboard核验分区，AI标题和正文整块裁剪；没有已校验建议时不显示AI空标题，整体AI不可用时固定建议标为规则分析处理建议。先复现2项预期失败，再完成修正；4文件38个定向测试、typecheck、lint、OpenSpec strict及diff格式检查通过。本轮未调用真实服务或重发通知，之前的发送记录不代表本次新标题已发送。

2026-09-29，本Change的本地实施与验收完成。分支为 `feat/host-scoped-alert-analysis`，基线提交 `ce86425`。保持未提交工作区；没有推送、合并、远端部署、Secret写入、云资源变更、主Specs同步或归档，三个前序Changes和需求历史备份未改动。

用户已批准方案及实施；另行授权了Cloudflare只读Schema/settings核验与一次互斥Host空结果探测。实施验收后，用户授权使用本地 `.env` 实测LLM，结果见下节；没有调用企业微信。

## 后续真实 LLM 烟测

2026-09-29执行 `npm run test:llm:live`，只加载LLM配置，使用单Host虚构Catalog v2测试AI v3。首次沙箱内因本地监听EPERM没有执行测试；授权沙箱外执行后完成3次真实HTTP请求，各一次、均HTTP200和finish_reason=stop。

- 第1轮：13932 ms，661 completion tokens，结构/引用/支持通过，attack Unknown。
- 第2轮：24405 ms，1265 completion tokens，`llm_output_truncated`，JSON解析前被32 KiB content上限拒绝。content_length诊断为封顶值65535，非精确长度；未记录原文，不能推断膨胀原因。
- 第3轮：15015 ms，685 completion tokens，结构/引用/支持通过，attack Unknown。

通过2/3，命令exit 1，真实Provider烟测未通过。未放宽预算、重试非法输出或修改生产代码。尚未覆盖3/5 Host真实调用、真实Cloudflare事件、企微和端到端部署；后续上线门禁仍未满足。本节与下方已完成的Mock验证分别记录。

## 指定告警的真实数据模拟

2026-09-29，用户指定 `booya.mx`、北京时间15:10:03，授权使用 `.env` 实际模拟并修复发现的问题（修复前说明原因与方案）。新增独立 `test/live/alert-simulation.config.mjs` / `alert-simulation.live.ts` 入口，复用生产Queue消息构造、GraphQL Client、Host Pipeline、LLM Client、校验和Formatter。未投递真实Queue、调用线上Webhook或部署。

未提供原始Payload及Webhook接收时间，明确假设接收时间等于告警时间；按仓库配置固定UTC窗口 `2026-09-29T06:40:03.000Z` 至 `2026-09-29T07:11:03.000Z`（北京时间14:40:03至15:11:03）。Payload参考事件数为模拟占位0，不参与统计。每次GraphQL请求及技术重试均在测试入口核对Zone和该窗口。

- Zone解析成功，3次GraphQL请求返回478条Zone事件、1个Host；该Host发现计数与独立计数均478，样本50条，采集与样本状态均success。
- 发现的实际Host为 `www.booya.mx`。配置Top3并不意味着必须返回3个Host；本轮已分析1个，事件覆盖估计100.0%，没有推断Zone总Host数量。
- Catalog为9568 bytes，1次真实LLM请求，Host AI支持验证通过、整体available。规则关注HIGH、攻击类型Unknown；快照事件全部标记block，不等于证明全部攻击已阻止。
- 生成带“历史告警模拟测试”标记的1217 UTF-8 bytes通知，保留窗口及模拟追踪ID。通知写入权限0600的临时文件，目录权限0700；未记录真实IP/Path/样本/模型原文至仓库。
- 联调1/1通过，测试耗时16805 ms。NotificationClient为本地预览适配器，Pipeline返回sent只代表适配器完成，不代表企微投递；入口日志已明确preview/not_called。

没有复现前一节的正文超预算错误，不据单次通过宣称Provider稳定，也未放宽预算或修改生产分析逻辑。新增模拟配置最初未被现有ESLint Node配置例外覆盖，已按原有真实测试配置方式补充；类型检查和Lint结果另据执行记录核对。真实企微发送仍待用户对该目的地明确选择。

## 通知展示调整与真实发送

2026-09-29用户明确要求隐藏无法判断的攻击类型，并授权向 `.env` 机器人发送。原因是Formatter此前对所有非Bot结果固定追加未知类型占位；现仅在校验通过的Bot结果展示带限定语的判断，内部Unknown、支持规则、风险及降级提示不变。四类通知回归先出现4项预期失败；同步旧文案断言后，通知及Host Pipeline共4文件30测试通过，typecheck/lint通过。

真实发送复用前次固定窗口已校验通知，只删除精确的未知类型占位，未重复采集或调用LLM。一次企业微信请求返回HTTP200、errcode=0，通知1193 UTF-8 bytes，包含历史模拟标记与原模拟ID。临时目录中的notification-updated.txt和send-result.json保留发送文本与受控回执，未记录Webhook值。此结果证明机器人接口接受了该文本，不代表远端Worker部署或真实Queue验收。

GitNexus对Formatter影响返回LOW/0调用方，源码仍确认Pipeline调用关系；全工作区detect-changes包含既有Host变更，不能将全量结果视为本次两行展示修改。未提交、推送或部署。

## 官方查询证据

### 后续通知排版验证（2026-09-29）

按用户给定格式，Host显示顺序采用一至五的中文编号；维度标签单独一行，同类Top明细合并为原子区块；移除通知中的规则关注等级，内部阈值/计算/排序不变。集中建议增加有效Cloudflare Dashboard链接，缺失或不安全时回退官方入口。覆盖去掉重复的所选Host尾注，但保留截断/失败/口径不一致提示与排名独立、采样限定。Bot和LOW的必要限定语保留。

新增排版断言先出现5项预期失败，再实施Formatter修改；补充路径分组、中文编号和5类链接回退验证。最终43文件336个Mock测试通过，typecheck/lint通过；未再次读取.env、调用真实服务、发送通知或部署。实际规则定义核对src/analysis/host-analysis.ts和wrangler.jsonc：比例阈值未设置最小事件量门槛，单事件100%集中度也可导致HIGH；这是现有规则语义，本次不调整。

GitNexus Formatter impact为LOW/0调用方，源码确认Pipeline调用；全工作区detect-changes为50文件112符号45流程CRITICAL，覆盖此前批准的大变更，非本次显示层修改新增影响。未修改共享Schema、规则或AI支持判定。本节是新增排版验收，前述真实企微回执对应修改前版式，不能冒充本版式的真实发送。

2026-09-24完成官方认证introspection，确认WAF两种Filter的clientRequestHTTPHost精确过滤、datetime_geq/leq、聚合维度、九个样本字段、orderBy及uint64/string/Time标量。随后在用户确认的目标Zone读取settings；元数据只保留脱敏字段/限制，详见 `test/fixtures/graphql/host-schema-contract.json`。

| 节点 | enabled | 最大窗口秒 | 字段上限 | 返回条数上限 | 可回溯秒 |
| --- | --- | --- | --- | --- | --- |
| firewallEventsAdaptiveGroups | true | 259200 | 30 | 10000 | 2678400 |
| firewallEventsAdaptive | true | 2592000 | 40 | 10000 | 2678400 |

7alias探测先确认AND的官方类型，再使用两个不同Host精确条件同时成立的互斥过滤。HTTP200、无GraphQL errors、7个结果数组均为空；没有读取实际事件。该结果只证明字段、权限和查询形状可用，不保证真实负载下不会出现配额、复杂度、采样差异或超时。

## 最终检查

| 检查 | 结果 |
| --- | --- |
| npm run types（关闭dotenv） | 通过，已刷新hostLimit配置类型 |
| npm run typecheck | 通过 |
| npm run lint | 通过 |
| npm test | 43个文件、330个测试全部通过；Workers插件运行 |
| Wrangler deploy --dry-run --keep-vars | 本地打包通过，未部署 |
| OpenSpec strict / workflow | 通过；状态更新后再次检查 |
| git diff --check | 通过 |
| 凭据扫描 | 78个变更/新增文件，未发现非虚构凭据；未读取.env/.dev.vars |
| 受保护范围 | 旧Changes、主Specs、历史备份的diff为空 |

Vitest配置主动关闭dotenv加载，测试使用虚构bindings和Mock。首次在沙箱内无法监听127.0.0.1，未执行测试；获本地执行权限后全部通过。未配置真实Secrets的提示、既有punycode弃用提示，以及Wrangler对Node类型的建议不影响上述结果；未因此增加依赖或写入凭据。

## TDD 与审查修正

- 配置/Queue先出现11项预期失败，ID边界先出现2项失败；实现后47项定向测试通过。
- Host DTO、查询、编排、独立统计、目录、v3客户端和通知的新入口均先以缺失行为/接口复现RED，再实现至GREEN。挂起响应体与超出截止的退避分别有失败回归。
- 独立只读审查提出4项问题：跨Host Finding依赖可被去前缀转换掩盖；控制字符ID膨胀；失败Host丢发现计数；只有全局省略标记。已逐项修复并通过回归。
- 目录新增Finding归属/依赖/数值验证，Action分子与比例公式、事件速率公式校验；样本真实Host与namespace不一致拒绝。大体积可选证据先整项压缩，避免在内部旧预算处提前丢掉整个Host。
- 通知中的特殊ID使用显式、可逆的UTF-8或UTF-16LE Base64表示；不截断ID。五Host同时失败/降级及最长ID仍有有界最小布局，每Host独立省略标记，并保留比占位符更短的实际名称。
- 补充修复畸形GraphQL errors被忽略、Client返回Host错配、Queue样本上限，以及本地格式化错误误归为WeCom错误。
- 最近一轮修正后全量330项通过，不以早期阶段性测试替代最终结果。

## Scenario 覆盖

以下文件名相对于test/，组合覆盖delta中全部29个Scenario。

| Scenario组 | 主要证据 |
| --- | --- |
| Same path / Different sources / Host及Zone分母 | unit/analysis/host-statistics.test.ts；fixtures/host-analysis.ts |
| Identical retry window / Config changes / Queue新旧兼容 | integration/host-graphql-client.test.ts；unit/pipeline/window.test.ts；unit/domain/queue-message.test.ts；fixtures/queue-v1.ts |
| Null or truncated hosts / Top host coverage | unit/analysis/host-statistics.test.ts；unit/analyzers/host-waf-analyzer.test.ts |
| Unverified schema | 已授权官方核验及graphql/host-schema-contract.json；未以Mock冒充远端证据 |
| GraphQL errors / Budget exhausted | unit/clients/cloudflare-graphql-schema.test.ts；integration/host-graphql-client.test.ts |
| UA及速率分母 / 口径不一致 / 零事件 | unit/analysis/host-statistics.test.ts；unit/analyzers/waf-analyzer.test.ts |
| One host failed / Discovery counts differ | unit/analysis/host-statistics.test.ts；unit/analyzers/host-waf-analyzer.test.ts |
| Cross-host evidence / Wrong denominator / Independent ranks | unit/analysis/host-evidence.test.ts；unit/analysis/evidence.test.ts |
| One invalid host / Invalid envelope / Missing Host | unit/analysis/host-ai-analyzer.test.ts；unit/analysis/ai-analyzer.test.ts；integration/llm-client.test.ts |
| Bot threshold / Unsupported attack / cherry-picked risk | unit/analysis/evidence.test.ts；unit/analysis/host-evidence.test.ts；unit/notification/formatter.test.ts |
| Protection outcome / Host ordering | unit/notification/host-formatter.test.ts；unit/notification/formatter.test.ts |
| Multilingual / 1999-2000-2001字节 / 长ID | unit/notification/blocks.test.ts；unit/notification/host-formatter.test.ts |
| New oversized ID / Historical unrepresentable | integration/cloudflare-alert-route.test.ts；unit/pipeline/process-alert.test.ts |
| Notification retries / post-send safety | integration/full-pipeline.test.ts；integration/structured-evidence-pipeline.test.ts；integration/queue-handler.test.ts；unit/pipeline/process-alert.test.ts |
| Safe host diagnostics | integration/log-redaction.test.ts；integration/failure-matrix.test.ts；unit/observability/ai-diagnostics.test.ts |
| 四类完整通知输入 | fixtures/host-notifications.ts及对应参数化Formatter测试 |
| 输入/输出体积预算 | integration/host-llm-client.test.ts（转义后的64KiB messages、96KiB请求、128KiB响应、32KiB content） |

目录的Host/Zone/总数硬限额由严格Schema与类型数上限共同约束；构造器按整项及依赖闭包裁剪。并非每个数值上限都存在可同时满足其他更严格结构约束的正例，不通过伪造合法目录来宣称边界通过。

## GitNexus 与范围

已刷新当前功能分支索引，未启用embeddings或改写AGENTS/技能。对当前分支执行detect-changes，结果为CRITICAL，覆盖采集、统计、目录、AI、Formatter及Pipeline主链；这与批准的跨模块范围一致。

buildHostEvidenceCatalog的impact为HIGH（3个受影响符号、2个直接依赖、4个流程）；源码确认直接消费者为runHostAIAnalysis和formatHostWeComMessage，间接进入processHostAlert与Worker handler。图对部分接口/导出别名给出0调用方，已用rg及源码核对，未将低评分当作完整性证明。未跟踪的新文件另行纳入源码审查、类型检查与测试，不把git diff统计当作全部新增文件清单。

## 兼容与发布边界

Queue仍为v1，hostLimit缺失固定3；旧Consumer忽略新增字段并恢复Zone分析。新HTTP入口限制ID为128 UTF-8字节，旧Queue仍可解析。对外仅Catalog v2 / AI v3；内部策略视图用于复用原支持规则，不构成旧Provider输出兼容路径。

真实v3 Provider单Host虚构烟测为2/3；后续指定历史窗口的真实数据模拟为1/1，通过不抹去此前失败。3/5 Host真实验证、企微与实际部署验收仍未完成。单条消息、有限Host及采样意味着覆盖有限；比例不可比较时明确未知。至少一次投递可能产生重复通知，不承诺exactly-once。发生发布退化应整包回滚，不能拆开回滚Prompt、Schema、支持校验或Formatter。
