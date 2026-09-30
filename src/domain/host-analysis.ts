import { z } from "zod";
import { EvidenceItemSchema, SecurityEventSampleSchema, IncidentSchema } from "./incident";
import { StatisticsSchema } from "./statistics";
import { FindingSchema } from "./finding";

export const EventCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const HostIdSchema = z.string().regex(/^h[0-4]$/u);
export const SelectedHostSchema = z.object({
  hostId: HostIdSchema,
  host: z.string().refine((value) => value.trim().length > 0),
  discoveryCount: EventCountSchema,
});
export const ZoneDiscoverySchema = z.object({
  zoneTotalEvents: EventCountSchema,
  topHosts: z.array(z.object({ host: z.string().nullable(), count: EventCountSchema })).max(10),
}).superRefine((value, context) => {
  const names = value.topHosts.map((item) => item.host);
  if (new Set(names).size !== names.length) context.addIssue({ code: "custom", message: "duplicate host" });
});
export const HostAggregatesSchema = z.object({
  topIps: z.array(EvidenceItemSchema).max(10),
  topPaths: z.array(EvidenceItemSchema).max(10),
  topCountries: z.array(EvidenceItemSchema).max(10),
  topAsns: z.array(EvidenceItemSchema).max(10),
  actions: z.array(EvidenceItemSchema).max(20),
  sources: z.array(EvidenceItemSchema).max(20),
});
export const HostCollectionSchema = SelectedHostSchema.extend({
  collectionStatus: z.enum(["success", "empty", "partial", "failed"]),
  hostTotalEvents: EventCountSchema.nullable(),
  aggregates: HostAggregatesSchema.nullable(),
  samples: z.array(SecurityEventSampleSchema).max(100),
  samplesStatus: z.enum(["success", "failed", "not_requested"]),
  errorCode: z.string().optional(),
  failure: z.object({
    externalService: z.literal("cloudflare"), errorCode: z.string(),
    failureKind: z.enum(["timeout", "network", "dns", "tls", "connection", "http", "invalid_response", "service_error", "unknown"]),
    retryable: z.boolean(), durationMs: z.number().nonnegative(), httpStatus: z.number().optional(),
  }).optional(),
}).superRefine((value, context) => {
  const failed = value.collectionStatus === "failed";
  if (failed ? value.hostTotalEvents !== null || value.aggregates !== null || value.samplesStatus !== "not_requested" : value.hostTotalEvents === null || value.aggregates === null) {
    context.addIssue({ code: "custom", message: "inconsistent collection state" });
  }
  if (value.samplesStatus !== "success" && value.samples.length !== 0) context.addIssue({ code: "custom", message: "unavailable samples" });
  if (value.samples.some((sample) => sample.clientRequestHTTPHost !== value.host)) context.addIssue({ code: "custom", message: "sample host mismatch" });
});
export type SelectedHost = z.infer<typeof SelectedHostSchema>;
export type ZoneDiscovery = z.infer<typeof ZoneDiscoverySchema>;
export type HostAggregates = z.infer<typeof HostAggregatesSchema>;
export type HostCollection = z.infer<typeof HostCollectionSchema>;

export const HostStatisticsSchema = StatisticsSchema.extend({
  hostId: HostIdSchema,
  zoneShare: z.number().min(0).max(100).nullable(),
  nonEmptyUaSampleCount: EventCountSchema,
});
export const HostFindingSchema = FindingSchema.extend({ hostId: HostIdSchema });
export const HostQualitySchema = z.object({
  aggregateConsistent: z.boolean(), discoveryConsistent: z.boolean(),
  actionsComplete: z.boolean(), sourcesComplete: z.boolean(),
  reasons: z.array(z.enum(["aggregate_inconsistent", "discovery_inconsistent", "actions_incomplete", "sources_incomplete", "samples_unavailable"])),
});
export const HostAnalysisSchema = z.object({
  collection: HostCollectionSchema,
  statistics: HostStatisticsSchema.nullable(),
  findings: z.array(HostFindingSchema).max(8),
  quality: HostQualitySchema,
  ruleAttention: z.enum(["LOW", "MEDIUM", "HIGH", "Unknown"]),
});
export type HostAnalysis = z.infer<typeof HostAnalysisSchema>;
export type HostStatistics = z.infer<typeof HostStatisticsSchema>;
export type HostQuality = z.infer<typeof HostQualitySchema>;

export const ZoneOverviewSchema = z.object({
  zoneTotalEvents: EventCountSchema,
  discoveredHosts: ZoneDiscoverySchema.shape.topHosts,
  selectedHostCount: z.number().int().min(0).max(5),
  analyzedHostCount: z.number().int().min(0).max(5),
  failedHostCount: z.number().int().min(0).max(5),
  sampleFailedHostCount: z.number().int().min(0).max(5),
  qualityFailedHostCount: z.number().int().min(0).max(5),
  topHostsTruncated: z.boolean(),
  invalidHostEvents: EventCountSchema,
  coverage: z.object({ events: EventCountSchema.nullable(), ratio: z.number().min(0).max(100).nullable(), status: z.enum(["comparable", "inconsistent", "unavailable", "empty"]) }),
});
export const HostIncidentSchema = IncidentSchema.omit({ totalEvents: true, evidence: true, samples: true }).extend({
  zone: ZoneOverviewSchema,
  hosts: z.array(HostAnalysisSchema).max(5),
});
export type HostIncident = z.infer<typeof HostIncidentSchema>;
