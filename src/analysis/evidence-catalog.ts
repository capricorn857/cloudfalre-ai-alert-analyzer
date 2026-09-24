import type { AIAnalysisInput } from "./evidence";
import {
  EvidenceCatalogSchema,
  type EvidenceCatalog,
  type EvidenceEntry,
} from "../domain/evidence-catalog";
import { FindingSchema, type Finding, type FindingType } from "../domain/finding";
import { IncidentSchema, type EvidenceItem, type SecurityEventSample } from "../domain/incident";
import { StatisticsSchema, type Concentration, type Statistics } from "../domain/statistics";
import { AppError } from "../observability/errors";
import { z } from "zod";

const MAX_ITEMS_PER_DIMENSION = 10;
const MAX_VALUE_BYTES = 2048;
const MAX_CATALOG_BYTES = 128 * 1024;
const AIAnalysisInputSchema = z
  .object({
    incident: IncidentSchema,
    statistics: StatisticsSchema,
    findings: z.array(FindingSchema),
  })
  .strict();

type CatalogReason = "invalid_catalog" | "inconsistent_source" | "catalog_budget_exceeded";
interface MutableOmissions {
  aggregateItems: number;
  samples: number;
  oversizedValues: number;
  dependentItems: number;
}

function catalogError(reason: CatalogReason): AppError {
  return new AppError("ai_catalog_invalid", "ai_catalog_invalid", false, undefined, {
    validationStage: "catalog",
    validationReason: reason,
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function stringsWithinLimit(value: unknown): boolean {
  if (typeof value === "string") return byteLength(value) <= MAX_VALUE_BYTES;
  if (Array.isArray(value)) return value.every(stringsWithinLimit);
  if (typeof value !== "object" || value === null) return true;
  return Object.values(value).every(stringsWithinLimit);
}

function sameTop(statistic: Concentration | null, items: readonly EvidenceItem[]): boolean {
  if (statistic === null) return true;
  const first = items[0];
  return first?.value === statistic.value && first.count === statistic.count;
}

const findingDependencies: Record<
  FindingType,
  { statId: string; scope: "aggregate" | "sample"; value: (statistics: Statistics) => number | null }
> = {
  ip_concentration: { statId: "stat:ip", scope: "aggregate", value: (stats) => stats.topIp?.ratio ?? null },
  path_concentration: {
    statId: "stat:path",
    scope: "aggregate",
    value: (stats) => stats.topPath?.ratio ?? null,
  },
  country_concentration: {
    statId: "stat:country",
    scope: "aggregate",
    value: (stats) => stats.topCountry?.ratio ?? null,
  },
  asn_concentration: {
    statId: "stat:asn",
    scope: "aggregate",
    value: (stats) => stats.topAsn?.ratio ?? null,
  },
  allow_ratio: { statId: "stat:allow", scope: "aggregate", value: (stats) => stats.allowRatio },
  block_ratio: { statId: "stat:block", scope: "aggregate", value: (stats) => stats.blockRatio },
  user_agent_concentration: {
    statId: "stat:ua",
    scope: "sample",
    value: (stats) => stats.userAgentConcentration?.ratio ?? null,
  },
  request_rate: {
    statId: "stat:rate",
    scope: "aggregate",
    value: (stats) => stats.requestRatePerSecond,
  },
};

function validateSources(input: AIAnalysisInput, nonNullUaSampleCount: number): void {
  const { incident, statistics, findings } = input;
  if (
    statistics.totalEvents !== incident.totalEvents ||
    statistics.dataSufficient !== (statistics.totalEvents > 0) ||
    !sameTop(statistics.topIp, incident.evidence.topIps) ||
    !sameTop(statistics.topPath, incident.evidence.topPaths) ||
    !sameTop(statistics.topCountry, incident.evidence.topCountries) ||
    !sameTop(statistics.topAsn, incident.evidence.topAsns) ||
    (statistics.userAgentConcentration?.count ?? 0) > nonNullUaSampleCount
  ) {
    throw catalogError("inconsistent_source");
  }

  const findingTypes = new Set<FindingType>();
  for (const finding of findings) {
    if (findingTypes.has(finding.type)) throw catalogError("inconsistent_source");
    findingTypes.add(finding.type);
    const expected = findingDependencies[finding.type].value(statistics);
    if (finding.level === "unknown") {
      if (finding.value !== null || finding.threshold !== null) {
        throw catalogError("inconsistent_source");
      }
      continue;
    }
    if (
      expected === null ||
      finding.value !== expected ||
      finding.threshold === null ||
      finding.value < finding.threshold
    ) {
      throw catalogError("inconsistent_source");
    }
  }
}

function appendAggregateDimension(
  entries: EvidenceEntry[],
  omissions: MutableOmissions,
  type: Extract<EvidenceEntry["type"], `aggregate_${string}`>,
  source: Extract<EvidenceEntry["source"], `incident.evidence.${string}`>,
  idDimension: string,
  items: readonly EvidenceItem[],
): void {
  omissions.aggregateItems += Math.max(0, items.length - MAX_ITEMS_PER_DIMENSION);
  for (const [index, item] of items.slice(0, MAX_ITEMS_PER_DIMENSION).entries()) {
    if (!stringsWithinLimit(item)) {
      omissions.oversizedValues += 1;
      continue;
    }
    entries.push({
      id: `agg:${idDimension}:${String(index)}`,
      type,
      source,
      scope: "aggregate",
      value: { ...item },
    } as EvidenceEntry);
  }
}

function appendConcentration(
  entries: EvidenceEntry[],
  omissions: MutableOmissions,
  id: "stat:ip" | "stat:path" | "stat:country" | "stat:asn",
  type: "stat_ip" | "stat_path" | "stat_country" | "stat_asn",
  source:
    | "statistics.topIp"
    | "statistics.topPath"
    | "statistics.topCountry"
    | "statistics.topAsn",
  value: Concentration | null,
): boolean {
  if (value === null) return false;
  if (!stringsWithinLimit(value)) {
    omissions.oversizedValues += 1;
    return true;
  }
  entries.push({ id, type, source, scope: "aggregate", value: { ...value } } as EvidenceEntry);
  return false;
}

function appendSamples(
  entries: EvidenceEntry[],
  omissions: MutableOmissions,
  samples: readonly SecurityEventSample[],
): void {
  omissions.samples += Math.max(0, samples.length - MAX_ITEMS_PER_DIMENSION);
  for (const [index, sample] of samples.slice(0, MAX_ITEMS_PER_DIMENSION).entries()) {
    if (!stringsWithinLimit(sample)) {
      omissions.oversizedValues += 1;
      continue;
    }
    entries.push({
      id: `sample:${String(index)}`,
      type: "sample",
      source: "incident.samples",
      scope: "sample",
      value: { ...sample },
    });
  }
}

function riskAssessable(
  statistics: Statistics,
  findings: readonly Finding[],
  catalogComplete: boolean,
): boolean {
  return (
    statistics.dataSufficient &&
    catalogComplete &&
    statistics.topIp !== null &&
    statistics.topPath !== null &&
    statistics.topCountry !== null &&
    statistics.topAsn !== null &&
    statistics.allowRatio !== null &&
    statistics.blockRatio !== null &&
    statistics.challengeRatio !== null &&
    statistics.requestRatePerSecond !== null &&
    !(findings.length > 0 && findings.every((finding) => finding.level === "unknown"))
  );
}

function buildValidatedEvidenceCatalog(input: AIAnalysisInput): EvidenceCatalog {
  const nonNullUaSampleCount = input.incident.samples.filter(
    (sample) => sample.userAgent !== null,
  ).length;
  validateSources(input, nonNullUaSampleCount);

  if (!stringsWithinLimit(input.incident.resource)) throw catalogError("invalid_catalog");

  const omissions: MutableOmissions = {
    aggregateItems: 0,
    samples: 0,
    oversizedValues: 0,
    dependentItems: 0,
  };
  const entries: EvidenceEntry[] = [
    {
      id: "ctx:0",
      type: "context",
      source: "incident.context",
      scope: "context",
      value: {
        resource: input.incident.resource,
        analysisWindow: { ...input.incident.analysisWindow },
      },
    },
    {
      id: "total:0",
      type: "total",
      source: "statistics.totalEvents",
      scope: "aggregate",
      value: { totalEvents: input.statistics.totalEvents },
    },
  ];

  const dimensions = [
    ["aggregate_ip", "incident.evidence.topIps", "ip", input.incident.evidence.topIps],
    ["aggregate_path", "incident.evidence.topPaths", "path", input.incident.evidence.topPaths],
    ["aggregate_host", "incident.evidence.topHosts", "host", input.incident.evidence.topHosts],
    ["aggregate_country", "incident.evidence.topCountries", "country", input.incident.evidence.topCountries],
    ["aggregate_asn", "incident.evidence.topAsns", "asn", input.incident.evidence.topAsns],
    ["aggregate_action", "incident.evidence.actions", "action", input.incident.evidence.actions],
    ["aggregate_source", "incident.evidence.sources", "source", input.incident.evidence.sources],
  ] as const;
  for (const [type, source, idDimension, items] of dimensions) {
    appendAggregateDimension(entries, omissions, type, source, idDimension, items);
  }

  let catalogContentOmitted = appendConcentration(
    entries,
    omissions,
    "stat:ip",
    "stat_ip",
    "statistics.topIp",
    input.statistics.topIp,
  );
  catalogContentOmitted = appendConcentration(
    entries,
    omissions,
    "stat:path",
    "stat_path",
    "statistics.topPath",
    input.statistics.topPath,
  ) || catalogContentOmitted;
  catalogContentOmitted = appendConcentration(
    entries,
    omissions,
    "stat:country",
    "stat_country",
    "statistics.topCountry",
    input.statistics.topCountry,
  ) || catalogContentOmitted;
  catalogContentOmitted = appendConcentration(
    entries,
    omissions,
    "stat:asn",
    "stat_asn",
    "statistics.topAsn",
    input.statistics.topAsn,
  ) || catalogContentOmitted;

  const ratios = [
    ["stat:allow", "stat_allow", "statistics.allowRatio", input.statistics.allowRatio],
    ["stat:block", "stat_block", "statistics.blockRatio", input.statistics.blockRatio],
    ["stat:challenge", "stat_challenge", "statistics.challengeRatio", input.statistics.challengeRatio],
  ] as const;
  for (const [id, type, source, ratio] of ratios) {
    if (ratio !== null) {
      entries.push({ id, type, source, scope: "aggregate", value: { ratio } } as EvidenceEntry);
    }
  }
  if (input.statistics.requestRatePerSecond !== null) {
    entries.push({
      id: "stat:rate",
      type: "stat_rate",
      source: "statistics.requestRatePerSecond",
      scope: "aggregate",
      value: { eventsPerSecond: input.statistics.requestRatePerSecond },
    });
  }
  if (input.statistics.userAgentConcentration !== null) {
    const value = { ...input.statistics.userAgentConcentration, denominator: nonNullUaSampleCount };
    if (stringsWithinLimit(value)) {
      entries.push({
        id: "stat:ua",
        type: "stat_ua",
        source: "statistics.userAgentConcentration",
        scope: "sample",
        value,
      });
    } else {
      omissions.oversizedValues += 1;
      catalogContentOmitted = true;
    }
  }

  const availableIds = new Set(entries.map((entry) => entry.id));
  for (const finding of input.findings) {
    const dependency = findingDependencies[finding.type];
    if (finding.level === "unknown" && dependency.value(input.statistics) === null) continue;
    if (!availableIds.has(dependency.statId)) {
      omissions.dependentItems += 1;
      continue;
    }
    entries.push({
      id: `finding:${finding.type}`,
      type: "finding",
      source: "findings",
      scope: dependency.scope,
      value: {
        findingType: finding.type,
        level: finding.level,
        value: finding.value,
        threshold: finding.threshold,
        statId: dependency.statId,
      },
    } as EvidenceEntry);
  }
  appendSamples(entries, omissions, input.incident.samples);

  const catalogComplete = !catalogContentOmitted && omissions.dependentItems === 0;
  entries.splice(1, 0, {
    id: "quality:0",
    type: "quality",
    source: "derived.quality",
    scope: "context",
    value: {
      dataSufficient: input.statistics.dataSufficient,
      riskAssessable: riskAssessable(input.statistics, input.findings, catalogComplete),
      catalogComplete,
      sampleCount: input.incident.samples.length,
      nonNullUaSampleCount,
    },
  });

  const candidate = { version: 1 as const, entries, omitted: omissions };
  if (byteLength(JSON.stringify(candidate)) > MAX_CATALOG_BYTES) {
    throw catalogError("catalog_budget_exceeded");
  }
  const parsed = EvidenceCatalogSchema.safeParse(candidate);
  if (!parsed.success) throw catalogError("invalid_catalog");
  return parsed.data;
}

export function buildEvidenceCatalog(input: AIAnalysisInput): EvidenceCatalog {
  const parsed = AIAnalysisInputSchema.safeParse(input);
  if (!parsed.success) throw catalogError("invalid_catalog");
  return buildValidatedEvidenceCatalog(parsed.data);
}
