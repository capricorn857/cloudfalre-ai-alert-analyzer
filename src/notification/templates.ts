import type { ValidatedAIAnalysis } from "../analysis/evidence";

export interface FormatterOptions {
  readonly timeZone: string;
  readonly maxLength: number;
  readonly topLimit: number;
}

const MAX_VALUE_BYTES = 2048;

const encoder = new TextEncoder();

type CatalogView = ValidatedAIAnalysis["catalog"];

type EntryView = CatalogView["entries"][number];

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

export function escapeValue(value: string): string {
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

export function displayTime(value: string, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(value));
  return `${formatted} ${timeZone === "Asia/Shanghai" ? "GMT+8" : escapeValue(timeZone)}`;
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

export function observationText(item: ValidatedAIAnalysis["analysis"]["observations"][number], catalog: CatalogView): string {
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
      ? `固定窗口平均事件速率为 ${String(stat.value.eventsPerSecond)} 次/秒；不代表峰值、并发或业务请求速率。`
      : "当前证据未形成受支持判断。";
  }
  const stat = firstOfType(catalog, item.evidenceIds, "stat_ua");
  return stat?.type === "stat_ua"
    ? `非空 UA 样本中 [${escapeValue(stat.value.value)}] 为 ${String(stat.value.count)} / ${String(stat.value.denominator)}，${String(stat.value.ratio)}%；不代表总体流量占比。`
    : "当前证据未形成受支持判断。";
}

export function recommendationText(item: ValidatedAIAnalysis["analysis"]["recommendations"][number], catalog: CatalogView): string {
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
