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

function displayTime(value: string, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
  const zoneLabel = timeZone === "Asia/Shanghai" ? "GMT+8" : timeZone;
  return `${formatted} ${zoneLabel}`;
}

function percent(count: number, total: number): string {
  if (total <= 0) return "N/A";
  return `${String(Math.round((count / total) * 1000) / 10)}%`;
}

function topList(title: string, items: readonly EvidenceItem[], total: number, limit: number): string {
  if (items.length === 0) return `${title}\n无数据`;
  return [
    title,
    ...items.slice(0, limit).map(
      (item, index) =>
        `${String(index + 1)}. ${item.value} ${String(item.count)} (${percent(item.count, total)})`,
    ),
  ].join("\n");
}

function identityHeader(snapshot: SnapshotAnalysisResult, options: FormatterOptions): string {
  const message = snapshot.message;
  return [
    "【Cloudflare WAF 安全告警】",
    `域名: ${message.alert.resource}`,
    `告警时间: ${displayTime(message.alert.alertTime, options.timeZone)}`,
    `分析窗口: ${displayTime(message.analysisWindow.start, options.timeZone)} - ${displayTime(message.analysisWindow.end, options.timeZone)}`,
    `数据截至: ${displayTime(message.analysisWindow.end, options.timeZone)}`,
    `incident_id: ${message.incidentId}`,
    `correlation_id: ${message.correlationId}`,
  ].join("\n");
}

function recommendations(ai: AIAnalysisResult): string {
  if (ai.status !== "available" || ai.analysis.recommendations.length === 0) return "建议\n请人工核验告警与 Cloudflare Dashboard。";
  return [
    "建议",
    ...ai.analysis.recommendations.slice(0, 3).map((item, index) => `${String(index + 1)}. ${item.slice(0, 180)}`),
  ].join("\n");
}

function successDetails(snapshot: SnapshotAnalysisSuccess, ai: AIAnalysisResult, limit: number): string {
  const { incident, statistics, findings } = snapshot;
  const facts = [
    `快照事件数: ${String(statistics.totalEvents)}`,
    `Payload 参考事件数: ${String(incident.payloadEventsCount)}`,
    topList("Top IP", incident.evidence.topIps, statistics.totalEvents, limit),
    topList("Top Country", incident.evidence.topCountries, statistics.totalEvents, limit),
    topList("Top ASN", incident.evidence.topAsns, statistics.totalEvents, limit),
    topList("Top Path", incident.evidence.topPaths, statistics.totalEvents, limit),
    topList("Cloudflare Action", incident.evidence.actions, statistics.totalEvents, limit),
  ];

  if (snapshot.status === "empty") {
    facts.push("当前固定分析窗口未查询到足够的 Security Events 数据。");
  }
  if (ai.status === "available") {
    facts.push(
      "AI 分析",
      ai.analysis.summary,
      "Evidence",
      ...ai.analysis.evidence.map((item) => `- ${item}`),
    );
  } else {
    facts.push(
      "AI 分析暂不可用",
      `原因: ${ai.reason}`,
      "规则分析",
      ...(findings.length === 0
        ? ["未发现达到配置阈值的规则"]
        : findings.map((finding) => `- ${finding.type}: ${finding.level}; ${finding.evidence}`)),
    );
  }
  if (incident.dashboardLink !== undefined) facts.push(`Cloudflare Dashboard: ${incident.dashboardLink}`);
  return facts.join("\n\n");
}

export function formatWeComMessage(
  result: NotificationResult,
  options: FormatterOptions,
): string {
  const header = identityHeader(result.snapshot, options);
  const status =
    result.snapshot.status === "collection_failed"
      ? `Cloudflare 数据采集失败\nerror_code: ${result.snapshot.errorCode}\nAI 分析暂不可用`
      : result.ai.status === "available"
        ? `风险等级: ${result.ai.analysis.riskLevel}\n攻击类型: ${result.ai.analysis.attackType}\n置信度: ${String(result.ai.analysis.confidence)}`
        : "风险等级: Unknown\nAI 分析暂不可用";
  const tail = recommendations(result.ai);
  const details =
    result.snapshot.status === "collection_failed"
      ? "未生成 Top 列表、统计或 AI 结论，以避免使用不完整数据。"
      : successDetails(result.snapshot, result.ai, options.topLimit);
  const fixed = `${header}\n\n${status}`;
  const full = `${fixed}\n\n${details}\n\n${tail}`;
  if (full.length <= options.maxLength) return full;

  const marker = "\n...[内容已截断]...\n";
  const available = options.maxLength - fixed.length - tail.length - marker.length - 4;
  if (available <= 0) return `${fixed}\n\n${tail}`.slice(0, options.maxLength);
  return `${fixed}\n\n${details.slice(0, available)}${marker}${tail}`.slice(0, options.maxLength);
}
