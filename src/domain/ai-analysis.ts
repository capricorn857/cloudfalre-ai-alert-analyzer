import { z } from "zod";

export const AttackTypeSchema = z.enum([
  "Scanning",
  "Brute Force",
  "Credential Stuffing",
  "API Abuse",
  "Bot",
  "Vulnerability Scanning",
  "Unknown",
]);

const EvidenceIdsSchema = z.array(z.string().min(1).max(64).regex(/^[a-z0-9:_]+$/u)).max(4);
const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL", "Unknown"]);
const ObservationKindSchema = z.enum(["aggregate_concentration", "action_ratio", "request_rate", "sample_ua_concentration", "sample_observed", "insufficient_data"]);
const DimensionSchema = z.enum(["ip", "path", "country", "asn", "allow", "block", "challenge", "rate", "ua", "sample", "none"]);
const RecommendationKindSchema = z.enum(["review_source", "review_target", "review_waf", "verify_sample", "manual_dashboard"]);
const ConfidenceSchema = z.number().min(0).max(1);

export const AIAnalysisWireSchema = z.strictObject({
  schema_version: z.literal(2),
  risk: z.strictObject({ level: RiskLevelSchema, evidence_ids: EvidenceIdsSchema }),
  attack: z.strictObject({ type: AttackTypeSchema, confidence: ConfidenceSchema, evidence_ids: EvidenceIdsSchema }),
  observations: z.array(z.strictObject({ kind: ObservationKindSchema, dimension: DimensionSchema, evidence_ids: EvidenceIdsSchema })).max(6),
  recommendations: z.array(z.strictObject({ kind: RecommendationKindSchema, evidence_ids: EvidenceIdsSchema })).min(1).max(3),
});

export const AIAnalysisSchema = z.strictObject({
  schemaVersion: AIAnalysisWireSchema.shape.schema_version,
  risk: z.strictObject({ level: RiskLevelSchema, evidenceIds: EvidenceIdsSchema }),
  attack: z.strictObject({ type: AttackTypeSchema, confidence: ConfidenceSchema, evidenceIds: EvidenceIdsSchema }),
  observations: z.array(z.strictObject({ kind: ObservationKindSchema, dimension: DimensionSchema, evidenceIds: EvidenceIdsSchema })).max(6),
  recommendations: z.array(z.strictObject({ kind: RecommendationKindSchema, evidenceIds: EvidenceIdsSchema })).min(1).max(3),
});

export function toAIAnalysis(output: z.infer<typeof AIAnalysisWireSchema>): AIAnalysis {
  return AIAnalysisSchema.parse({
    schemaVersion: output.schema_version,
    risk: { level: output.risk.level, evidenceIds: output.risk.evidence_ids },
    attack: { type: output.attack.type, confidence: output.attack.confidence, evidenceIds: output.attack.evidence_ids },
    observations: output.observations.map(({ kind, dimension, evidence_ids }) => ({ kind, dimension, evidenceIds: evidence_ids })),
    recommendations: output.recommendations.map(({ kind, evidence_ids }) => ({ kind, evidenceIds: evidence_ids })),
  });
}

export const AIUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.string().min(1),
});

export type AIAnalysis = z.infer<typeof AIAnalysisSchema>;
export type AIUnavailable = z.infer<typeof AIUnavailableSchema>;
