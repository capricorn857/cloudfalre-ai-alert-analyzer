import { z } from "zod";

import { SecurityEventSampleSchema } from "./incident";
import { UtcDateTimeSchema } from "./time";

const MAX_VALUE_BYTES = 2048;
const MAX_CATALOG_BYTES = 128 * 1024;

const StrictAnalysisWindowSchema = z
  .object({
    start: UtcDateTimeSchema,
    end: UtcDateTimeSchema,
  })
  .strict()
  .refine((window) => Date.parse(window.start) <= Date.parse(window.end), {
    message: "analysis window start must not be after end",
  });

const EvidenceIdSchema = z.string().regex(/^[a-z0-9:_]{1,64}$/u);
const AggregateValueSchema = z
  .object({ value: z.string().min(1), count: z.number().int().nonnegative() })
  .strict();
const ConcentrationValueSchema = AggregateValueSchema.extend({
  ratio: z.number().min(0).max(100),
}).strict();

const entry = <
  Type extends string,
  Source extends string,
  Scope extends "context" | "aggregate" | "sample",
  Value extends z.ZodType,
>(type: Type, source: Source, scope: Scope, value: Value) =>
  z
    .object({
      id: EvidenceIdSchema,
      type: z.literal(type),
      source: z.literal(source),
      scope: z.literal(scope),
      value,
    })
    .strict();

const ContextEntrySchema = entry(
  "context",
  "incident.context",
  "context",
  z
    .object({
      resource: z.string().min(1),
      analysisWindow: StrictAnalysisWindowSchema,
    })
    .strict(),
);
const QualityEntrySchema = entry(
  "quality",
  "derived.quality",
  "context",
  z
    .object({
      dataSufficient: z.boolean(),
      riskAssessable: z.boolean(),
      catalogComplete: z.boolean(),
      sampleCount: z.number().int().nonnegative(),
      nonNullUaSampleCount: z.number().int().nonnegative(),
    })
    .strict(),
);
const TotalEntrySchema = entry(
  "total",
  "statistics.totalEvents",
  "aggregate",
  z.object({ totalEvents: z.number().int().nonnegative() }).strict(),
);

const AggregateEntrySchemas = [
  entry("aggregate_ip", "incident.evidence.topIps", "aggregate", AggregateValueSchema),
  entry("aggregate_path", "incident.evidence.topPaths", "aggregate", AggregateValueSchema),
  entry("aggregate_host", "incident.evidence.topHosts", "aggregate", AggregateValueSchema),
  entry("aggregate_country", "incident.evidence.topCountries", "aggregate", AggregateValueSchema),
  entry("aggregate_asn", "incident.evidence.topAsns", "aggregate", AggregateValueSchema),
  entry("aggregate_action", "incident.evidence.actions", "aggregate", AggregateValueSchema),
  entry("aggregate_source", "incident.evidence.sources", "aggregate", AggregateValueSchema),
] as const;

const ConcentrationEntrySchemas = [
  entry("stat_ip", "statistics.topIp", "aggregate", ConcentrationValueSchema),
  entry("stat_path", "statistics.topPath", "aggregate", ConcentrationValueSchema),
  entry("stat_country", "statistics.topCountry", "aggregate", ConcentrationValueSchema),
  entry("stat_asn", "statistics.topAsn", "aggregate", ConcentrationValueSchema),
] as const;
const RatioEntrySchemas = [
  entry(
    "stat_allow",
    "statistics.allowRatio",
    "aggregate",
    z.object({ ratio: z.number().min(0).max(100) }).strict(),
  ),
  entry(
    "stat_block",
    "statistics.blockRatio",
    "aggregate",
    z.object({ ratio: z.number().min(0).max(100) }).strict(),
  ),
  entry(
    "stat_challenge",
    "statistics.challengeRatio",
    "aggregate",
    z.object({ ratio: z.number().min(0).max(100) }).strict(),
  ),
] as const;
const RateEntrySchema = entry(
  "stat_rate",
  "statistics.requestRatePerSecond",
  "aggregate",
  z.object({ eventsPerSecond: z.number().nonnegative() }).strict(),
);
const UserAgentEntrySchema = entry(
  "stat_ua",
  "statistics.userAgentConcentration",
  "sample",
  ConcentrationValueSchema.extend({ denominator: z.number().int().nonnegative() }).strict(),
);

const FindingValueBaseSchema = z
  .object({
    level: z.enum(["medium", "high", "unknown"]),
    value: z.number().nonnegative().nullable(),
    threshold: z.number().nonnegative().nullable(),
    statId: EvidenceIdSchema,
  })
  .strict();
const AggregateFindingEntrySchema = entry(
  "finding",
  "findings",
  "aggregate",
  FindingValueBaseSchema.extend({
    findingType: z.enum([
      "ip_concentration",
      "path_concentration",
      "country_concentration",
      "asn_concentration",
      "allow_ratio",
      "block_ratio",
      "request_rate",
    ]),
  }).strict(),
);
const SampleFindingEntrySchema = entry(
  "finding",
  "findings",
  "sample",
  FindingValueBaseSchema.extend({
    findingType: z.literal("user_agent_concentration"),
  }).strict(),
);
const SampleEntrySchema = entry(
  "sample",
  "incident.samples",
  "sample",
  SecurityEventSampleSchema.strict(),
);

export const EvidenceEntrySchema = z.union([
  ContextEntrySchema,
  QualityEntrySchema,
  TotalEntrySchema,
  ...AggregateEntrySchemas,
  ...ConcentrationEntrySchemas,
  ...RatioEntrySchemas,
  RateEntrySchema,
  UserAgentEntrySchema,
  AggregateFindingEntrySchema,
  SampleFindingEntrySchema,
  SampleEntrySchema,
]);

const entryTypeOrder: Record<EvidenceEntry["type"], number> = {
  context: 0,
  quality: 1,
  total: 2,
  aggregate_ip: 3,
  aggregate_path: 4,
  aggregate_host: 5,
  aggregate_country: 6,
  aggregate_asn: 7,
  aggregate_action: 8,
  aggregate_source: 9,
  stat_ip: 10,
  stat_path: 11,
  stat_country: 12,
  stat_asn: 13,
  stat_allow: 14,
  stat_block: 15,
  stat_challenge: 16,
  stat_rate: 17,
  stat_ua: 18,
  finding: 19,
  sample: 20,
};

const findingStatIds: Record<string, string> = {
  ip_concentration: "stat:ip",
  path_concentration: "stat:path",
  country_concentration: "stat:country",
  asn_concentration: "stat:asn",
  allow_ratio: "stat:allow",
  block_ratio: "stat:block",
  user_agent_concentration: "stat:ua",
  request_rate: "stat:rate",
};

export const EvidenceCatalogSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(EvidenceEntrySchema).max(100),
    omitted: z
      .object({
        aggregateItems: z.number().int().nonnegative(),
        samples: z.number().int().nonnegative(),
        oversizedValues: z.number().int().nonnegative(),
        dependentItems: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    const typeCounts = new Map<EvidenceEntry["type"], number>();
    const findingTypes = new Set<string>();
    let previousTypeOrder = -1;
    const expectedIds: Partial<Record<EvidenceEntry["type"], string>> = {
      context: "ctx:0",
      quality: "quality:0",
      total: "total:0",
      stat_ip: "stat:ip",
      stat_path: "stat:path",
      stat_country: "stat:country",
      stat_asn: "stat:asn",
      stat_allow: "stat:allow",
      stat_block: "stat:block",
      stat_challenge: "stat:challenge",
      stat_rate: "stat:rate",
      stat_ua: "stat:ua",
    };
    for (const item of catalog.entries) {
      if (ids.has(item.id)) {
        context.addIssue({ code: "custom", message: "duplicate evidence ID", path: ["entries"] });
      }
      ids.add(item.id);
      typeCounts.set(item.type, (typeCounts.get(item.type) ?? 0) + 1);
      const currentTypeOrder = entryTypeOrder[item.type];
      if (currentTypeOrder < previousTypeOrder) {
        context.addIssue({ code: "custom", message: "evidence entries out of order", path: ["entries"] });
      }
      previousTypeOrder = currentTypeOrder;

      const fixedId = expectedIds[item.type];
      const aggregateDimension = item.type.startsWith("aggregate_")
        ? item.type.slice("aggregate_".length)
        : undefined;
      const idIsValid =
        fixedId === item.id ||
        (aggregateDimension !== undefined &&
          new RegExp(`^agg:${aggregateDimension}:[0-9]$`, "u").test(item.id)) ||
        (item.type === "sample" && /^sample:[0-9]$/u.test(item.id)) ||
        (item.type === "finding" && item.id === `finding:${item.value.findingType}`);
      if (!idIsValid) {
        context.addIssue({ code: "custom", message: "invalid fixed evidence ID", path: ["entries"] });
      }

      const pending: unknown[] = [item.value];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === "string" && new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) {
          context.addIssue({ code: "custom", message: "evidence value exceeds byte limit", path: ["entries"] });
          break;
        }
        if (typeof value === "object" && value !== null) {
          pending.push(...Object.values(value as Record<string, unknown>));
        }
      }

      if (item.type === "finding") {
        if (findingTypes.has(item.value.findingType)) {
          context.addIssue({ code: "custom", message: "duplicate finding type", path: ["entries"] });
        }
        findingTypes.add(item.value.findingType);
        const levelValuesValid =
          item.value.level === "unknown"
            ? item.value.value === null && item.value.threshold === null
            : item.value.value !== null &&
              item.value.threshold !== null &&
              item.value.value >= item.value.threshold;
        if (
          item.value.statId !== findingStatIds[item.value.findingType] ||
          !levelValuesValid
        ) {
          context.addIssue({ code: "custom", message: "inconsistent finding value", path: ["entries"] });
        }
      }
    }

    for (const requiredType of ["context", "quality", "total"] as const) {
      if (typeCounts.get(requiredType) !== 1) {
        context.addIssue({ code: "custom", message: "required singleton missing", path: ["entries"] });
      }
    }
    for (const [type, count] of typeCounts) {
      const maximum = type.startsWith("aggregate_") || type === "sample" ? 10 : type === "finding" ? 8 : 1;
      if (count > maximum) {
        context.addIssue({ code: "custom", message: "entry type limit exceeded", path: ["entries"] });
      }
    }
    for (const item of catalog.entries) {
      if (item.type === "finding" && !ids.has(item.value.statId)) {
        context.addIssue({ code: "custom", message: "finding dependency missing", path: ["entries"] });
      }
    }
    if (new TextEncoder().encode(JSON.stringify(catalog)).byteLength > MAX_CATALOG_BYTES) {
      context.addIssue({ code: "custom", message: "catalog byte limit exceeded", path: [] });
    }
  });

export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
export type EvidenceCatalog = z.infer<typeof EvidenceCatalogSchema>;
