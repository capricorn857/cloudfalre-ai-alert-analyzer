import { ATTENTION_SCOPE, EventScopeSchema } from "../domain/event-scope";
import { HostEvidenceCatalogSchema, type HostEvidenceCatalog, type ScopedEvidenceEntry } from "../domain/host-evidence";
import { HostAIAnalysisWireSchema, toAIAnalysis, type HostAIAnalysisWire } from "../domain/ai-analysis";
import type { HostAnalysis } from "../domain/host-analysis";
import type { QueueMessage } from "../domain/queue-message";
import { EvidenceCatalogSchema, type EvidenceEntry } from "../domain/evidence-catalog";
import { buildEvidenceCatalog, omitLeastImportantEvidence } from "./evidence-catalog";
import { validateAIAnalysisEvidence, type ValidatedAIAnalysis } from "./evidence";
import { validationError } from "../observability/ai-diagnostics";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const emptyOmissions = { aggregateItems: 0, samples: 0, oversizedValues: 0, dependentItems: 0 };

function verifySource(host: HostAnalysis, message: QueueMessage): void {
  const { statistics: stats, collection, findings } = host;
  if (!EventScopeSchema.safeParse(collection).success || collection.aggregates?.actions.some((item) => item.value === "block") || collection.samples.some((sample) => sample.action === "block")) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  if (stats === null || collection.aggregates === null || stats.hostId !== collection.hostId || stats.totalEvents !== collection.hostTotalEvents || findings.some((finding) => finding.hostId !== collection.hostId)) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  const ratio = (count: number, denominator: number) => Math.round(count / denominator * 100_000) / 1000;
  for (const [stat, items] of [[stats.topIp, collection.aggregates.topIps], [stats.topPath, collection.aggregates.topPaths], [stats.topCountry, collection.aggregates.topCountries], [stats.topAsn, collection.aggregates.topAsns]] as const) {
    if (stat !== null && (stat.ratio !== ratio(stat.count, stats.totalEvents) || stat.value !== items[0]?.value || stat.count !== items[0].count)) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  }
  const nonEmpty = collection.samples.filter((sample) => sample.userAgent !== null && sample.userAgent.trim().length > 0);
  if (stats.nonEmptyUaSampleCount !== nonEmpty.length) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  if (stats.userAgentConcentration !== null && (stats.userAgentConcentration.count !== nonEmpty.filter((sample) => sample.userAgent === stats.userAgentConcentration?.value).length || stats.userAgentConcentration.ratio !== ratio(stats.userAgentConcentration.count, nonEmpty.length))) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  for (const [stat, actions] of [[stats.allowRatio, ["allow"]], [stats.blockRatio, ["block"]], [stats.challengeRatio, ["challenge", "managed_challenge"]]] as const) {
    const count = collection.aggregates.actions.filter((item) => (actions as readonly string[]).includes(item.value)).reduce((sum, item) => sum + item.count, 0);
    if (stat !== null && stat !== ratio(count, stats.totalEvents)) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
  }
  const duration = (Date.parse(message.analysisWindow.end) - Date.parse(message.analysisWindow.start)) / 1000;
  if (stats.requestRatePerSecond !== null && stats.requestRatePerSecond !== stats.totalEvents / duration) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
}

export function buildHostEvidenceCatalog(input: { message: QueueMessage; zoneTotalEvents: number; zoneDenominatorComparable?: boolean; hosts: readonly HostAnalysis[] }): HostEvidenceCatalog {
  const { message } = input;
  const entries: ScopedEvidenceEntry[] = [
    { id: "zone:ctx:0", type: "context", source: "incident.context", scope: "context", owner: { kind: "zone" }, value: { resource: message.alert.resource, analysisWindow: message.analysisWindow } },
    { id: "zone:total:0", type: "total", source: "statistics.totalEvents", scope: "aggregate", owner: { kind: "zone" }, value: { totalEvents: input.zoneTotalEvents } },
  ];
  const hostIds: string[] = [];
  const unavailableHosts: string[] = [];
  const omitted = { ...emptyOmissions };
  for (const host of input.hosts) {
    const { collection, statistics } = host;
    const hostId = collection.hostId;
    if (statistics === null || statistics.totalEvents <= 0 || collection.aggregates === null) continue;
    try {
      verifySource(host, message);
      if (input.zoneDenominatorComparable === false && statistics.zoneShare !== null) throw validationError("ai_catalog_invalid", "catalog", "inconsistent_source");
      const local = buildEvidenceCatalog({
        incident: { resource: collection.host, analysisWindow: message.analysisWindow, totalEvents: statistics.totalEvents,
          evidence: { ...collection.aggregates, topHosts: [] }, samples: collection.samples },
        statistics, findings: host.findings,
      }, { compactOptional: true });
      for (const key of Object.keys(omitted) as (keyof typeof omitted)[]) omitted[key] += local.omitted[key];
      for (const entry of local.entries) if (Number(entry.id.split(":").at(-1)) >= 5) {
        if (entry.type === "sample") omitted.samples++;
        else if (entry.type.startsWith("aggregate_")) omitted.aggregateItems++;
      }
      const projected: ScopedEvidenceEntry[] = local.entries.filter((entry) => !(entry.type.startsWith("aggregate_") || entry.type === "sample") || Number(entry.id.split(":").at(-1)) < 5).map((entry) => {
        const value = entry.type === "finding" ? { ...entry.value, statId: `${hostId}:${entry.value.statId}` } : entry.value;
        const actionNames = entry.type === "stat_allow" ? ["allow"] : entry.type === "stat_block" ? ["block"] : entry.type === "stat_challenge" ? ["challenge", "managed_challenge"] : undefined;
        const numerator = actionNames === undefined ? undefined : collection.aggregates?.actions.filter((item) => actionNames.includes(item.value)).reduce((sum, item) => sum + item.count, 0);
        const denominator = entry.type === "stat_ua" ? { kind: "host_nonempty_ua_samples" as const, count: statistics.nonEmptyUaSampleCount, referenceId: `${hostId}:quality:0` }
          : entry.type === "stat_rate" ? { kind: "window_seconds" as const, count: (Date.parse(message.analysisWindow.end) - Date.parse(message.analysisWindow.start)) / 1000, referenceId: `${hostId}:ctx:0`, numerator: statistics.totalEvents }
          : entry.type.startsWith("stat_") || entry.type.startsWith("aggregate_") ? { kind: "host_events" as const, count: statistics.totalEvents, referenceId: `${hostId}:total:0`, ...(numerator === undefined ? {} : { numerator }) } : undefined;
        return { ...entry, id: `${hostId}:${entry.id}`, value, owner: { kind: "host", hostId }, ...(denominator === undefined ? {} : { denominator }) } as ScopedEvidenceEntry;
      });
      for (const entry of projected) if (entry.type === "quality") entry.value.riskAssessable = entry.value.riskAssessable && host.quality.aggregateConsistent;
      while (bytes(projected) > 10 * 1024) {
        const removed = omitLeastImportantEvidence(projected);
        if (removed === undefined) throw validationError("ai_catalog_invalid", "catalog", "catalog_budget_exceeded");
        if (removed.type === "sample") omitted.samples++;
        else omitted.aggregateItems++;
      }
      entries.push(...projected);
      hostIds.push(hostId);
    } catch { unavailableHosts.push(hostId); }
  }
  return HostEvidenceCatalogSchema.parse({ version: 2, ...ATTENTION_SCOPE, incidentId: message.incidentId, correlationId: message.correlationId, entries, hostIds, unavailableHosts, omitted });
}

export interface ValidatedHostAIAnalysis {
  readonly hostId: string;
  readonly wire: HostAIAnalysisWire;
  readonly policy: ValidatedAIAnalysis;
  readonly catalog: HostEvidenceCatalog;
}
const validated = new WeakSet();
export const isValidatedHostAIAnalysis = (value: unknown): value is ValidatedHostAIAnalysis => typeof value === "object" && value !== null && validated.has(value);

export function validateHostAIAnalysis(raw: unknown, rawCatalog: HostEvidenceCatalog): ValidatedHostAIAnalysis {
  const parsed = HostAIAnalysisWireSchema.safeParse(raw);
  if (!parsed.success) throw validationError("llm_output_schema_invalid", "schema", "invalid_shape");
  const parsedCatalog = HostEvidenceCatalogSchema.safeParse(rawCatalog);
  if (!parsedCatalog.success) throw validationError("ai_catalog_invalid", "catalog", "invalid_catalog");
  const catalog = parsedCatalog.data;
  const wire = parsed.data;
  const hostId = wire.host_id;
  if (!catalog.hostIds.includes(hostId)) throw validationError("ai_reference_invalid", "reference", "reference_not_found");
  const nodes = [wire.risk, wire.attack, ...wire.observations, ...wire.recommendations];
  if (nodes.some((node) => node.evidence_ids.some((id) => !id.startsWith(`${hostId}:`)))) throw validationError("ai_reference_invalid", "reference", "host_mismatch");
  const entries = catalog.entries.filter((entry) => entry.owner.kind === "host" && entry.owner.hostId === hostId).map((entry) => {
    const local = { id: entry.id, type: entry.type, source: entry.source, scope: entry.scope, value: entry.value } as EvidenceEntry;
    return { ...local, id: local.id.slice(3), value: local.type === "finding" ? { ...local.value, statId: local.value.statId.slice(3) } : local.value } as EvidenceEntry;
  });
  const localCatalog = EvidenceCatalogSchema.parse({ version: 1, entries, omitted: emptyOmissions });
  const strip = <T extends { evidence_ids: string[] }>(node: T) => ({ ...node, evidence_ids: node.evidence_ids.map((id) => id.slice(3)) });
  const analysis = toAIAnalysis({ schema_version: 2, risk: strip(wire.risk), attack: strip(wire.attack), observations: wire.observations.map(strip), recommendations: wire.recommendations.map(strip) });
  const policy = validateAIAnalysisEvidence(analysis, localCatalog);
  const result = { hostId, wire, policy, catalog };
  freeze(result);
  validated.add(result);
  return result;
}

function freeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}
