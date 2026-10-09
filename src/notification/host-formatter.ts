import { EventScopeSchema } from "../domain/event-scope";
import { AppError } from "../observability/errors";
import type { HostSnapshotAnalysisResult } from "../domain/analysis-result";
import type { HostAIAnalysisResult } from "../analysis/ai-analyzer";
import type { HostAnalysis } from "../domain/host-analysis";
import { buildHostEvidenceCatalog, isValidatedHostAIAnalysis } from "../analysis/host-evidence";
import { assembleBlocks, type MessageSection } from "./blocks";
import { displayTime, escapeValue, recommendationText, observationText, type FormatterOptions } from "./templates";

const percentage = (value: number | null) => value === null ? "未知" : `${value.toFixed(1)}%`;
const attentionOrder = { HIGH: 0, MEDIUM: 1, Unknown: 2, LOW: 3 };
const hostNumbers = ["一", "二", "三", "四", "五"];

function dashboardUrl(value: string | undefined): string {
  try {
    const url = new URL(value ?? "https://dash.cloudflare.com/");
    if (url.protocol === "https:" && url.hostname === "dash.cloudflare.com" && !url.username && !url.password && !url.port && url.href.length <= 300) return url.href;
  } catch { /* Fall back to the official entry point. */ }
  return "https://dash.cloudflare.com/";
}

function protection(host: HostAnalysis): string {
  const stats = host.statistics;
  if (stats === null) return "待关注事件处理分布: 未知";
  if (!host.quality.actionsComplete || stats.totalEvents === 0) return "待关注事件处理分布: 未完整获取";
  return `待关注事件处理分布: allow ${percentage(stats.allowRatio)}；challenge ${percentage(stats.challengeRatio)}；其他动作保留`;
}

export function formatHostWeComMessage(result: { snapshot: HostSnapshotAnalysisResult; ai: HostAIAnalysisResult }, options: FormatterOptions): string {
  const { snapshot, ai } = result;
  if (snapshot.status === "suppressed") throw new AppError("notification_suppressed", "suppressed snapshots have no notification", false);
  const { message } = snapshot;
  const time = (value: string) => displayTime(value, options.timeZone);
  const adviceTitle = ai.status === "unavailable" ? "规则分析处理建议" : "人工核验处理建议";
  const advice = `${adviceTitle}:\n按相同窗口人工核验 Cloudflare Dashboard：\n${dashboardUrl(message.alert.dashboardLink)}`;
  const footer = [
    "各排名相互独立，事件可能采样。非block不代表攻击成功或已到达源站。",
    `告警时间: ${time(message.alert.alertTime)}`,
    `分析窗口: ${time(message.analysisWindow.start)} - ${time(message.analysisWindow.end)}`,
    `数据截至: ${time(message.analysisWindow.end)}`,
  ];
  // Identifiers may use a lossless encoding, but are never omitted or truncated.
  const identifiers = [`incident_id: ${escapeIdentifier(message.incidentId)}`, `correlation_id: ${escapeIdentifier(message.correlationId)}`];
  if (!("incident" in snapshot)) {
    const failureText = snapshot.status === "suppression_ineligible" ? (snapshot.reason === "action_unknown" ? "部分事件处理动作未知，无法可靠保留待关注范围；AI 不可用" : "数据口径不一致，无法可靠判断待关注事件；AI 不可用") : "Cloudflare 数据采集失败；AI 不可用";
    return assembleBlocks([
    { required: `【Cloudflare WAF 告警】\nZone: ${escapeValue(message.alert.resource)}\n${failureText}`, compact: "【Cloudflare WAF 告警】\nZone: [名称已省略]\n" + failureText, optional: [] },
    { required: advice, optional: [] },
    { required: [...footer, "覆盖: 未知", ...identifiers].join("\n"), optional: [] },
  ], options.maxLength);
  }
  const { incident } = snapshot;
  const zone = incident.zone;
  if (!EventScopeSchema.safeParse(zone).success || incident.hosts.some(({ collection }) => !EventScopeSchema.safeParse(collection).success || (collection.aggregates?.actions.some((item) => item.value === "block") ?? false) || collection.samples.some((sample) => sample.action === "block"))) throw new AppError("notification_scope_invalid", "invalid attention scope", false);
  let catalogMatches = false;
  try { catalogMatches = ai.catalog !== undefined && JSON.stringify(ai.catalog) === JSON.stringify(buildHostEvidenceCatalog({ message, zoneTotalEvents: zone.zoneTotalEvents, hosts: incident.hosts })); } catch { /* Invalid AI projection uses the rule fallback. */ }
  const suggestions: string[] = [];
  const sections: MessageSection[] = [{ required: `【Cloudflare WAF 告警】\nZone: ${escapeValue(incident.resource)}；待关注事件（已排除 action=block）: ${String(zone.zoneTotalEvents)}`, compact: `【Cloudflare WAF 告警】\nZone: [名称已省略]；待关注事件（已排除 action=block）: ${String(zone.zoneTotalEvents)}`, optional: [] }];
  const sorted = [...incident.hosts].sort((a, b) => attentionOrder[a.ruleAttention] - attentionOrder[b.ruleAttention] || b.collection.discoveryCount - a.collection.discoveryCount || (a.collection.host < b.collection.host ? -1 : a.collection.host > b.collection.host ? 1 : 0));
  for (const [index, host] of sorted.entries()) {
    const heading = `${hostNumbers[index] ?? String(index + 1)}：Host:`;
    const collection = host.collection;
    const stats = host.statistics;
    const candidate = ai.hosts.find((item) => item.hostId === collection.hostId);
    const validated = catalogMatches && candidate?.status === "available" && isValidatedHostAIAnalysis(candidate.analysis) && candidate.analysis.hostId === collection.hostId && JSON.stringify(candidate.analysis.catalog) === JSON.stringify(ai.catalog) ? candidate.analysis : undefined;
    const status: string[] = [];
    if (collection.collectionStatus === "failed") status.push("采集失败，事件数未知", `发现阶段: ${String(collection.discoveryCount)} 事件（未完成分析）`);
    else if (collection.samplesStatus === "failed") status.push("样本采集失败");
    if (!host.quality.aggregateConsistent && stats !== null) status.push("数据不完整");
    if (!host.quality.discoveryConsistent && stats !== null) status.push("聚合口径不一致");
    if (collection.aggregates?.actions.some((item) => item.value === "unknown") || collection.samples.some((sample) => sample.action === "unknown")) status.push("部分处理动作未知");
    if (stats?.totalEvents === 0) status.push("零事件，数据不足");
    if (validated === undefined) status.push("AI 降级，使用规则分析");
    const judgement = validated?.wire.attack.type === "Bot" ? [`疑似自动化特征（Bot，待人工核验）；模型自评 ${String(validated.wire.attack.confidence)}，非攻击概率`] : [];
    const summary = [protection(host), ...judgement,
      ...(host.ruleAttention === "LOW" ? ["未命中当前关注规则，不代表安全。"] : []), ...status];
    const count = stats === null ? "" : `；${String(stats.totalEvents)} 事件，占 Zone ${percentage(stats.zoneShare)}`;
    const name = escapeValue(collection.host);
    const compactStatus: string[] = [];
    if (collection.collectionStatus === "failed") compactStatus.push("采集失败，事件数未知", `发现阶段: ${String(collection.discoveryCount)} 事件（未完成分析）`);
    else if (collection.samplesStatus === "failed") compactStatus.push("样本采集失败");
    if (!host.quality.aggregateConsistent && stats !== null) compactStatus.push("数据不完整");
    if (!host.quality.discoveryConsistent && stats !== null) compactStatus.push("口径不一致");
    if (collection.aggregates?.actions.some((item) => item.value === "unknown") || collection.samples.some((sample) => sample.action === "unknown")) compactStatus.push("部分处理动作未知");
    if (stats?.totalEvents === 0) compactStatus.push("零事件，数据不足");
    if (validated === undefined) compactStatus.push("AI 降级");
    const compactProtection = protection(host);
    const omittedName = `${collection.hostId}（名称已省略）`;
    const compactName = new TextEncoder().encode(name).byteLength <= new TextEncoder().encode(omittedName).byteLength ? name : omittedName;
    const compact = [`${heading} ${compactName}`, compactProtection, ...(host.ruleAttention === "LOW" ? ["未命中当前关注规则，不代表安全。"] : []), ...compactStatus].join("\n");
    const section: MessageSection = { required: [`${heading} ${name}${count}`, ...summary].join("\n"), compact, optional: [], omissionMarker: "明细已省略" };
    const aggregates = collection.aggregates;
    if (aggregates !== null && stats !== null && stats.totalEvents > 0) {
      const dimensions = [ ["来源 IP", aggregates.topIps, Math.min(3, options.topLimit)], ["目标路径", aggregates.topPaths, Math.min(3, options.topLimit)],
        ["来源国家/地区", aggregates.topCountries, 1], ["来源 ASN", aggregates.topAsns, 1], ["触发来源", aggregates.sources, 1] ] as const;
      for (const [label, items, limit] of dimensions) {
        const selected = items.slice(0, limit);
        if (selected.length === 0) continue;
        if (selected.some((item) => new TextEncoder().encode(item.value).byteLength > 2048)) section.detailsOmitted = true;
        const consistent = items.reduce((sum, value) => sum + value.count, 0) <= stats.totalEvents && (label !== "触发来源" || host.quality.sourcesComplete);
        section.optional.push(`${label}:\n` + selected.map((item) => `[${escapeValue(item.value)}] ${String(item.count)}（${percentage(consistent ? item.count / stats.totalEvents * 100 : null)}）`).join("\n"));
      }
    }
    if (validated !== undefined) {
      for (const advice of validated.policy.analysis.recommendations) if (advice.kind !== "manual_dashboard") suggestions.push(`${name}: ${recommendationText(advice, validated.policy.catalog)}`);
      for (const observation of validated.policy.analysis.observations) if (["request_rate", "sample_ua_concentration", "sample_observed"].includes(observation.kind)) section.optional.push(observationText(observation, validated.policy.catalog));
    }
    sections.push(section);
  }
  if (incident.hosts.length === 0) sections.push({ required: zone.zoneTotalEvents === 0 ? "当前固定窗口零事件，数据不足。" : "当前发现范围没有可分析的非空 Host。", optional: [] });
  const aiSuggestions = [...new Set(suggestions)].slice(0, 2);
  sections.push({ required: advice, optional: aiSuggestions.length === 0 ? [] : [`AI 分析处理建议:\n${aiSuggestions.join("\n")}`] });
  const coverage = zone.coverage.status === "empty" ? "不适用" : percentage(zone.coverage.ratio);
  const coverageText = `覆盖: 已分析 ${String(zone.analyzedHostCount)} 个 Host；采集失败 ${String(zone.failedHostCount)} 个；事件覆盖估计 ${coverage}` + (zone.qualityFailedHostCount > 0 ? `；数据不完整 ${String(zone.qualityFailedHostCount)} 个` : "") + (zone.coverage.status === "inconsistent" ? "；聚合口径不一致" : "") + (zone.topHostsTruncated ? "；Top Host 范围有限" : "");
  sections.push({ required: [...footer, coverageText, ...identifiers].join("\n"), optional: [] });
  return assembleBlocks(sections, options.maxLength);
}

function escapeIdentifier(value: string): string {
  const escaped = Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") return "\\\\";
    return code < 32 || (code >= 127 && code <= 159) || code === 0x061c || code === 0x200e || code === 0x200f ||
      (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || (code >= 0xd800 && code <= 0xdfff)
      ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }).join("");
  const visible = escaped.startsWith("[utf8-base64:") || escaped.startsWith("[utf16le-base64:") ? "\\u005b" + escaped.slice(1) : escaped;
  const hasLoneSurrogate = Array.from(value).some((character) => { const code = character.codePointAt(0) ?? 0; return code >= 0xd800 && code <= 0xdfff; });
  const bytes = hasLoneSurrogate ? new Uint8Array(value.length * 2) : new TextEncoder().encode(value);
  if (hasLoneSurrogate) {
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  }
  const encoded = `[${hasLoneSurrogate ? "utf16le" : "utf8"}-base64:${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}]`;
  return new TextEncoder().encode(visible).byteLength <= encoded.length ? visible : encoded;
}
