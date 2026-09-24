import { isValidatedAIAnalysis, type ValidatedAIAnalysis } from "../analysis/evidence";
import { buildEvidenceCatalog } from "../analysis/evidence-catalog";
import type { AIAnalysisResult } from "../analysis/ai-analyzer";
import type { SnapshotAnalysisResult, SnapshotAnalysisSuccess } from "../domain/analysis-result";
import type { EvidenceItem } from "../domain/incident";

export interface NotificationResult {
  readonly snapshot: SnapshotAnalysisResult;
  readonly ai: AIAnalysisResult;
}

export interface FormatterOptions {
  readonly timeZone: string;
  readonly maxLength: number;
  readonly topLimit: number;
}

const MAX_MESSAGE_BYTES = 2000;
const MAX_VALUE_BYTES = 2048;
const encoder = new TextEncoder();
type CatalogView = ValidatedAIAnalysis["catalog"];
type EntryView = CatalogView["entries"][number];
type DisplayBlock = string | { readonly text: string; readonly compact: string };

function field(label: string, value: string): DisplayBlock {
  return { text: `${label}: ${escapeValue(value)}`, compact: `${label}: [值已省略]` };
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function escapeValue(value: string): string {
  if (bytes(value) > MAX_VALUE_BYTES) return "[值过长，已省略]";
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const unsafe = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x061c ||
      code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (!unsafe) return character;
    if (character === "\n") return "\\n";
    if (character === "\r") return "\\r";
    if (character === "\t") return "\\t";
    return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }).join("");
}

function displayTime(value: string, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
  return `${formatted} ${timeZone === "Asia/Shanghai" ? "GMT+8" : escapeValue(timeZone)}`;
}

function percent(count: number, total: number): string {
  return total <= 0 ? "N/A" : `${String(Math.round((count / total) * 1000) / 10)}%`;
}

function topLines(title: string, items: readonly EvidenceItem[], total: number, limit: number): DisplayBlock[] {
  if (items.length === 0) return [`${title}: 无数据`];
  return items.slice(0, Math.max(1, limit)).map((item, index) => ({
    text: `${title}${index === 0 ? ":" : ` ${String(index + 1)}:`} [${escapeValue(item.value)}] ${String(item.count)} (${percent(item.count, total)})`,
    compact: `${title}: [条目已省略]`,
  }));
}

function catalogMatchesSnapshot(value: ValidatedAIAnalysis, snapshot: SnapshotAnalysisSuccess): boolean {
  if (!isValidatedAIAnalysis(value)) return false;
  try {
    // Re-project existing facts only; never collect or calculate statistics here.
    return JSON.stringify(value.catalog) === JSON.stringify(buildEvidenceCatalog({
      incident: snapshot.incident, statistics: snapshot.statistics, findings: snapshot.findings,
    }));
  } catch {
    return false;
  }
}

function byId(catalog: CatalogView, id: string): EntryView | undefined {
  return catalog.entries.find((entry) => entry.id === id);
}

function firstOfType(catalog: CatalogView, ids: readonly string[], type: EntryView["type"]): EntryView | undefined {
  return ids.map((id) => byId(catalog, id)).find((entry) => entry?.type === type);
}

function finding(catalog: CatalogView, ids: readonly string[]): Extract<EntryView, { type: "finding" }> | undefined {
  const entry = firstOfType(catalog, ids, "finding");
  return entry?.type === "finding" ? entry : undefined;
}

function observationText(item: ValidatedAIAnalysis["analysis"]["observations"][number], catalog: CatalogView): string {
  const dimensionNames: Record<string, string> = { ip: "来源 IP", path: "目标路径", country: "来源国家/地区", asn: "来源 ASN" };
  if (item.kind === "insufficient_data") return "当前数据不足，未形成受支持判断。";
  if (item.kind === "sample_observed") {
    const entry = firstOfType(catalog, item.evidenceIds, "sample");
    if (entry?.type !== "sample") return "当前证据未形成受支持判断。";
    const sample = entry.value;
    return `该条样本事件（不代表总体趋势或攻击归因）：IP [${escapeValue(sample.clientIP)}]，路径 [${escapeValue(sample.clientRequestPath ?? "空")}]，UA [${escapeValue(sample.userAgent ?? "空")}]，Action [${escapeValue(sample.action)}]。`;
  }
  if (item.kind === "aggregate_concentration") {
    const statType = `stat_${item.dimension}` as EntryView["type"];
    const stat = firstOfType(catalog, item.evidenceIds, statType);
    const rule = finding(catalog, item.evidenceIds);
    if (stat === undefined || !["stat_ip", "stat_path", "stat_country", "stat_asn"].includes(stat.type) ||
      !("value" in stat.value) || !("count" in stat.value) || !("ratio" in stat.value) || rule === undefined)
      return "当前证据未形成受支持判断。";
    return `本次 GraphQL 快照的${dimensionNames[item.dimension] ?? item.dimension}集中度达到配置阈值：` +
      `[${escapeValue(stat.value.value)}] ${String(stat.value.count)}，${String(stat.value.ratio)}%，达到 ${rule.value.level} 阈值 ${String(rule.value.threshold)}%；不称该实体已恶意。`;
  }
  if (item.kind === "action_ratio") {
    const stat = firstOfType(catalog, item.evidenceIds, `stat_${item.dimension}` as EntryView["type"]);
    if (stat === undefined || !("ratio" in stat.value)) return "当前证据未形成受支持判断。";
    if (item.dimension === "challenge") return `本次 GraphQL 快照的 challenge 比例为 ${String(stat.value.ratio)}%；仅报告比例，不据此判断异常。`;
    const suffix = item.dimension === "allow" ? "不代表已确认攻击穿透" : "不代表本系统已执行封禁";
    return `本次 GraphQL 快照的 ${item.dimension} 比例达到配置阈值：${String(stat.value.ratio)}%；${suffix}。`;
  }
  if (item.kind === "request_rate") {
    const stat = firstOfType(catalog, item.evidenceIds, "stat_rate");
    return stat?.type === "stat_rate"
      ? `固定窗口平均 Security Events/s 为 ${String(stat.value.eventsPerSecond)}；不代表峰值、并发或业务请求速率。`
      : "当前证据未形成受支持判断。";
  }
  const stat = firstOfType(catalog, item.evidenceIds, "stat_ua");
  return stat?.type === "stat_ua"
    ? `非空 UA 样本中 [${escapeValue(stat.value.value)}] 为 ${String(stat.value.count)} / ${String(stat.value.denominator)}，${String(stat.value.ratio)}%；不代表总体流量占比。`
    : "当前证据未形成受支持判断。";
}

function recommendationText(item: ValidatedAIAnalysis["analysis"]["recommendations"][number], catalog: CatalogView): string {
  const entry = byId(catalog, item.evidenceIds[0] ?? "");
  switch (item.kind) {
    case "review_source":
      return entry !== undefined && "count" in entry.value
        ? `人工核验来源 [${escapeValue(entry.value.value)}] 是否为正常业务。` : "人工核验告警来源。";
    case "review_target":
      return entry !== undefined && "count" in entry.value
        ? `人工核验 [${escapeValue(entry.value.value)}] 的访问与业务日志。` : "人工核验告警目标。";
    case "review_waf": return "人工核对现有 WAF 处理情况；本系统未修改任何配置。";
    case "verify_sample":
      if (entry?.type === "sample") return `人工核验样本路径 [${escapeValue(entry.value.clientRequestPath ?? "空")}] 与 UA [${escapeValue(entry.value.userAgent ?? "空")}] 的业务来源。`;
      return entry?.type === "stat_ua" ? `人工核验非空 UA 样本 [${escapeValue(entry.value.value)}] 的业务来源。` : "人工核验事件样本。";
    case "manual_dashboard": return "使用相同固定窗口核验 Cloudflare Dashboard。";
  }
}

function aiBlocks(value: ValidatedAIAnalysis): { status: string; details: string[]; recommendations: string[] } {
  const { analysis, catalog } = value;
  const attack = analysis.attack.type === "Unknown"
    ? "攻击类型: Unknown\n置信度: 未作判断"
    : `攻击类型: 疑似自动化特征（Bot，待人工核验）\n模型自评置信度: ${String(analysis.attack.confidence)}（不是攻击概率）`;
  const observations = analysis.observations.map((item) => observationText(item, catalog));
  const attackSummary = analysis.attack.type === "Unknown"
    ? "攻击类型尚无法判断。"
    : "检测到疑似自动化特征（Bot，待人工核验）。";
  const summary = observations.length > 0
    ? `${observations.join(" ")} ${attackSummary}`
    : `当前证据未形成受支持的观察，${attackSummary}`;
  return {
    status: `规则关注等级: ${analysis.risk.level}（不代表已证实危害）${analysis.risk.level === "LOW" ? "\n未命中当前关注规则，不代表安全。" : analysis.risk.level === "Unknown" ? "\n当前证据未形成受支持判断。" : ""}\n${attack}`,
    details: ["AI 分析（程序模板）", summary, "Evidence", ...observations.map((text) => `- ${text}`)],
    recommendations: ["建议", ...analysis.recommendations.map((item, index) => `${String(index + 1)}. ${recommendationText(item, catalog)}`)],
  };
}

function ruleFallback(snapshot: SnapshotAnalysisSuccess): string[] {
  return ["AI 分析暂不可用", "规则分析", ...(snapshot.findings.length === 0
    ? ["未发现达到配置阈值的规则"]
    : snapshot.findings.map((item) => `- ${item.type}: ${item.level}; ${escapeValue(item.evidence)}`))];
}

function fits(value: string, limit: number): boolean {
  return value.length <= limit && bytes(value) <= Math.min(MAX_MESSAGE_BYTES, limit);
}

function assemble(required: readonly DisplayBlock[], optional: readonly DisplayBlock[], limit: number): string {
  const text = (block: DisplayBlock) => typeof block === "string" ? block : block.text;
  const selected = required.map(text);
  let omitted = false;
  // Replace complete variable fields, largest first, before admitting optional lines.
  const replacements = required.flatMap((block, index) => typeof block === "string" ? [] : [{ index, compact: block.compact, saving: bytes(block.text) - bytes(block.compact) }])
    .filter((item) => item.saving > 0).sort((left, right) => right.saving - left.saving);
  for (const replacement of replacements) {
    if (fits(selected.join("\n"), limit)) break;
    selected[replacement.index] = replacement.compact;
    omitted = true;
  }
  if (!fits(selected.join("\n"), limit)) {
    const minimal = "告警内容超出显示限制，已省略；请人工核验。";
    return fits(minimal, limit) ? minimal : "";
  }
  for (const block of optional) {
    const candidate = [...selected, text(block)].join("\n");
    if (fits(candidate, limit)) selected.push(text(block));
    else omitted = true;
  }
  if (omitted) {
    const marker = "[部分低优先级内容已省略]";
    if (fits([...selected, marker].join("\n"), limit)) selected.push(marker);
    else {
      while (selected.length > required.length && !fits([...selected, marker].join("\n"), limit)) selected.pop();
      if (fits([...selected, marker].join("\n"), limit)) selected.push(marker);
    }
  }
  return selected.join("\n");
}

export function formatWeComMessage(result: NotificationResult, options: FormatterOptions): string {
  const snapshot = result.snapshot;
  const message = snapshot.message;
  const header: DisplayBlock[] = ["【Cloudflare WAF 安全告警】", field("域名", message.alert.resource),
    `告警时间: ${displayTime(message.alert.alertTime, options.timeZone)}`,
    `分析窗口: ${displayTime(message.analysisWindow.start, options.timeZone)} - ${displayTime(message.analysisWindow.end, options.timeZone)}`,
    `数据截至: ${displayTime(message.analysisWindow.end, options.timeZone)}`,
    field("incident_id", message.incidentId), field("correlation_id", message.correlationId)];

  if (snapshot.status === "collection_failed") {
    return assemble([...header, "Cloudflare 数据采集失败", field("error_code", snapshot.errorCode),
      "风险等级: Unknown", "AI 分析暂不可用", "未生成 Top 列表、统计或 AI 结论，以避免使用不完整数据。",
      "建议", "请人工核验告警与 Cloudflare Dashboard。"], [], options.maxLength);
  }

  const usable = result.ai.status === "available" && catalogMatchesSnapshot(result.ai.analysis, snapshot)
    ? result.ai.analysis : undefined;
  const rendered = usable === undefined ? undefined : aiBlocks(usable);
  const required = [...header,
    rendered?.status ?? "规则关注等级: Unknown\nAI 分析暂不可用",
    `快照事件数: ${String(snapshot.statistics.totalEvents)}；Payload 参考事件数: ${String(snapshot.incident.payloadEventsCount)}`,
    ...(snapshot.status === "empty" ? ["当前固定分析窗口未查询到足够的 Security Events 数据。"] : [])];
  const factGroups = [
    topLines("Top IP", snapshot.incident.evidence.topIps, snapshot.statistics.totalEvents, options.topLimit),
    topLines("Top Country", snapshot.incident.evidence.topCountries, snapshot.statistics.totalEvents, options.topLimit),
    topLines("Top ASN", snapshot.incident.evidence.topAsns, snapshot.statistics.totalEvents, options.topLimit),
    topLines("Top Path", snapshot.incident.evidence.topPaths, snapshot.statistics.totalEvents, options.topLimit),
    topLines("Cloudflare Action", snapshot.incident.evidence.actions, snapshot.statistics.totalEvents, options.topLimit),
    topLines("Source", snapshot.incident.evidence.sources, snapshot.statistics.totalEvents, options.topLimit),
  ];
  const firstFacts = factGroups.flatMap((group) => group.slice(0, 1));
  const extraFacts = factGroups.flatMap((group) => group.slice(1));
  const fallback = rendered === undefined ? ruleFallback(snapshot) : [];
  const advice = rendered?.recommendations ?? ["建议", "请人工核验告警与 Cloudflare Dashboard。"];
  const dashboard = snapshot.incident.dashboardLink === undefined ? [] : [field("Cloudflare Dashboard", snapshot.incident.dashboardLink)];
  const firstAdvice = { text: advice.slice(0, 2).join("\n"), compact: "建议\n请人工核验告警与 Cloudflare Dashboard。" };
  const mustKeep = [...required, ...firstFacts, ...fallback.slice(0, 2), firstAdvice, ...dashboard];
  const optional = [...fallback.slice(2), ...extraFacts, ...(rendered?.details ?? []), ...advice.slice(2)];
  return assemble(mustKeep, optional, options.maxLength);
}
