import { HostAnalysisSchema, HostCollectionSchema, type HostAnalysis, type HostCollection, type HostQuality, type SelectedHost, type ZoneDiscovery } from "../domain/host-analysis";
import type { AnalysisWindow } from "../domain/queue-message";
import type { RulesConfig } from "../config/rules";
import type { Statistics } from "../domain/statistics";
import type { Finding } from "../domain/finding";
import { calculateStatistics } from "./statistics";
import { evaluateRules } from "./rules";

export function calculateRuleAttention(statistics: Statistics, findings: readonly Finding[], complete = true): HostAnalysis["ruleAttention"] {
  if (!complete || !statistics.dataSufficient || [statistics.topIp, statistics.topPath, statistics.topCountry, statistics.topAsn,
    statistics.allowRatio, statistics.blockRatio, statistics.challengeRatio, statistics.requestRatePerSecond].some((value) => value === null) ||
    (findings.length > 0 && findings.every((finding) => finding.level === "unknown"))) return "Unknown";
  const riskTypes = new Set(["ip_concentration", "path_concentration", "country_concentration", "asn_concentration", "allow_ratio", "request_rate"]);
  const risks = findings.filter((finding) => riskTypes.has(finding.type));
  return risks.some((finding) => finding.level === "high") ? "HIGH" : risks.some((finding) => finding.level === "medium") ? "MEDIUM" : "LOW";
}

export function selectHosts(discovery: ZoneDiscovery, limit: number): { hosts: SelectedHost[]; topHostsTruncated: boolean; invalidHostEvents: number } {
  const valid = discovery.topHosts.filter((item): item is { host: string; count: number } => typeof item.host === "string" && item.host.trim().length > 0 && item.count > 0)
    .sort((a, b) => b.count - a.count || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return {
    hosts: valid.slice(0, limit).map((item, index) => ({ hostId: `h${String(index)}`, host: item.host, discoveryCount: item.count })),
    topHostsTruncated: discovery.topHosts.length === 10 || valid.length > limit,
    invalidHostEvents: discovery.topHosts.filter((item) => !item.host?.trim()).reduce((sum, item) => sum + item.count, 0),
  };
}

export function analyzeHost(raw: HostCollection, zoneTotalEvents: number, analysisWindow: AnalysisWindow, rulesConfig: RulesConfig): HostAnalysis {
  const collection = HostCollectionSchema.parse(raw);
  const { aggregates, hostTotalEvents: total } = collection;
  const quality: HostQuality = { aggregateConsistent: false, discoveryConsistent: false, actionsComplete: false, sourcesComplete: false, reasons: [] };
  if (aggregates === null || total === null) return HostAnalysisSchema.parse({ collection, quality, statistics: null, findings: [], ruleAttention: "Unknown" });
  const sum = (items: { count: number }[]) => items.reduce((value, item) => value + item.count, 0);
  quality.actionsComplete = aggregates.actions.length < 20 && sum(aggregates.actions) === total;
  quality.sourcesComplete = aggregates.sources.length < 20 && sum(aggregates.sources) === total;
  quality.aggregateConsistent = Object.values(aggregates).every((items) => sum(items) <= total) && quality.actionsComplete && quality.sourcesComplete && !(total === 0 && collection.samples.length > 0);
  quality.discoveryConsistent = collection.discoveryCount === total && total <= zoneTotalEvents;
  if (!quality.aggregateConsistent) quality.reasons.push("aggregate_inconsistent");
  if (!quality.discoveryConsistent) quality.reasons.push("discovery_inconsistent");
  if (!quality.actionsComplete) quality.reasons.push("actions_incomplete");
  if (!quality.sourcesComplete) quality.reasons.push("sources_incomplete");
  if (collection.samplesStatus === "failed") quality.reasons.push("samples_unavailable");
  const statistics = {
    ...calculateStatistics({ totalEvents: total, analysisWindow, evidence: aggregates, samples: collection.samples, actionsComplete: quality.actionsComplete }),
    hostId: collection.hostId,
    zoneShare: quality.discoveryConsistent && zoneTotalEvents > 0 ? total / zoneTotalEvents * 100 : null,
    nonEmptyUaSampleCount: collection.samples.filter((sample) => sample.userAgent !== null && sample.userAgent.trim().length > 0).length,
  };
  const findings = evaluateRules(statistics, rulesConfig).map((finding) => ({ ...finding, hostId: collection.hostId }));
  return HostAnalysisSchema.parse({ collection, statistics, findings, quality,
    ruleAttention: calculateRuleAttention(statistics, findings, quality.aggregateConsistent) });
}

export function summarizeCoverage(zoneTotalEvents: number, hosts: readonly HostAnalysis[], discoveryConsistent = true) {
  const failed = hosts.filter((host) => host.collection.collectionStatus === "failed");
  const qualityFailed = hosts.filter((host) => host.statistics !== null && !host.quality.aggregateConsistent);
  const analyzed = hosts.filter((host) => host.statistics !== null && host.quality.aggregateConsistent);
  const count = analyzed.reduce((sum, host) => sum + (host.statistics?.totalEvents ?? 0), 0);
  const inconsistent = !discoveryConsistent || qualityFailed.length > 0 || hosts.some((host) => host.statistics !== null && !host.quality.discoveryConsistent) || count > zoneTotalEvents;
  const status = inconsistent ? "inconsistent" : zoneTotalEvents === 0 ? "empty" : analyzed.length === 0 ? "unavailable" : "comparable";
  return { analyzedHostCount: analyzed.length, failedHostCount: failed.length, qualityFailedHostCount: qualityFailed.length,
    sampleFailedHostCount: hosts.filter((host) => host.collection.samplesStatus === "failed").length,
    coverage: { events: status === "comparable" ? count : null, ratio: status === "comparable" ? count / zoneTotalEvents * 100 : null, status } };
}
