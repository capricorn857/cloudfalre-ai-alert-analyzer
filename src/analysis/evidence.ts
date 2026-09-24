import { AIAnalysisSchema, type AIAnalysis } from "../domain/ai-analysis";
import { EvidenceCatalogSchema, type EvidenceCatalog, type EvidenceEntry } from "../domain/evidence-catalog";
import type { Finding } from "../domain/finding";
import type { Incident } from "../domain/incident";
import type { Statistics } from "../domain/statistics";
import { safeValidationPaths, validationError, type ValidationReason } from "../observability/ai-diagnostics";

export interface AIAnalysisInput {
  readonly incident: Incident;
  readonly statistics: Statistics;
  readonly findings: Finding[];
}

export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
declare const validated: unique symbol;
export type ValidatedAIAnalysis = DeepReadonly<{ analysis: AIAnalysis; catalog: EvidenceCatalog }> & { readonly [validated]: true };
const validatedResults = new WeakSet();

export function isValidatedAIAnalysis(value: unknown): value is ValidatedAIAnalysis {
  return typeof value === "object" && value !== null && validatedResults.has(value);
}

function freeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

type EntryType = EvidenceEntry["type"];
type Role = readonly EntryType[];
const riskTypes = new Set(["ip_concentration", "path_concentration", "country_concentration", "asn_concentration", "allow_ratio", "request_rate"]);

export function validateAIAnalysisEvidence(raw: AIAnalysis, rawCatalog: EvidenceCatalog): ValidatedAIAnalysis {
  const parsed = AIAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    const error = validationError("llm_output_schema_invalid", "schema", "invalid_shape");
    throw errorWithSafePaths(error, safeValidationPaths(parsed.error.issues.map((issue) => issue.path)));
  }
  const catalogResult = EvidenceCatalogSchema.safeParse(rawCatalog);
  if (!catalogResult.success) throw validationError("ai_catalog_invalid", "catalog", "invalid_catalog");
  const analysis = parsed.data;
  const catalog = catalogResult.data;
  const entries = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const quality = catalog.entries.find((entry) => entry.type === "quality");
  if (quality?.type !== "quality") throw validationError("ai_catalog_invalid", "catalog", "invalid_catalog");
  const dataSufficient = quality.value.dataSufficient;
  const assessable = dataSufficient && quality.value.riskAssessable;
  const nodes = [
    { node: analysis.risk, path: "risk.evidence_ids" },
    { node: analysis.attack, path: "attack.evidence_ids" },
    ...analysis.observations.map((node) => ({ node, path: "observations[].evidence_ids" })),
    ...analysis.recommendations.map((node) => ({ node, path: "recommendations[].evidence_ids" })),
  ];
  const referenceCount = nodes.reduce((sum, { node }) => sum + node.evidenceIds.length, 0);
  function fail(code: string, reason: ValidationReason, path: string): never {
    throw validationError(code, code.startsWith("ai_reference") ? "reference" : "support", reason, path, { referenceCount, catalogEntryCount: catalog.entries.length });
  }
  for (const { node, path } of nodes) {
    if (new Set(node.evidenceIds).size !== node.evidenceIds.length) fail("ai_reference_invalid", "duplicate_reference", path);
  }
  const observationKeys = analysis.observations.map((node) => JSON.stringify([node.kind, node.dimension, [...node.evidenceIds].sort()]));
  if (new Set(observationKeys).size !== observationKeys.length) fail("ai_reference_invalid", "duplicate_claim", "observations");
  if (new Set(analysis.recommendations.map((node) => node.kind)).size !== analysis.recommendations.length) fail("ai_reference_invalid", "duplicate_recommendation", "recommendations");
  for (const { node, path } of nodes) {
    if (node.evidenceIds.some((id) => !entries.has(id))) fail("ai_reference_invalid", "reference_not_found", path);
  }

  function roles(ids: readonly string[], expected: readonly Role[], path: string): EvidenceEntry[] {
    if (ids.length < expected.length) fail("ai_claim_unsupported", "missing_support", path);
    if (ids.length > expected.length) fail("ai_claim_unsupported", "unrelated_reference", path);
    const remaining = ids.map((id) => entries.get(id)).filter((entry): entry is EvidenceEntry => entry !== undefined);
    return expected.map((types) => {
      const index = remaining.findIndex((entry) => types.includes(entry.type));
      if (index < 0) fail("ai_reference_type_mismatch", "reference_type_mismatch", path);
      const found = remaining.splice(index, 1)[0];
      if (found === undefined) fail("ai_claim_unsupported", "missing_support", path);
      return found;
    });
  }
  function requireData(path: string, risk = false): void {
    if (!(risk ? assessable : dataSufficient)) fail("ai_data_insufficient", "insufficient_data", path);
  }
  function support(stat: EvidenceEntry | undefined, finding: EvidenceEntry | undefined, path: string, high = false): void {
    if (stat === undefined || finding?.type !== "finding") fail("ai_claim_unsupported", "missing_support", path);
    const expectedFinding: Partial<Record<EntryType, string>> = {
      stat_ip: "ip_concentration", stat_path: "path_concentration", stat_country: "country_concentration",
      stat_asn: "asn_concentration", stat_allow: "allow_ratio", stat_block: "block_ratio",
      stat_ua: "user_agent_concentration", stat_rate: "request_rate",
    };
    const value = "ratio" in stat.value ? stat.value.ratio : "eventsPerSecond" in stat.value ? stat.value.eventsPerSecond : null;
    if (finding.value.statId !== stat.id || finding.value.findingType !== expectedFinding[stat.type] ||
      finding.value.level === "unknown" || (high && finding.value.level !== "high") ||
      value === null || value !== finding.value.value || finding.value.threshold === null || value < finding.value.threshold)
      fail("ai_claim_unsupported", "support_condition_failed", path);
  }
  const riskFindings = catalog.entries.filter((entry) => entry.type === "finding" && riskTypes.has(entry.value.findingType) && entry.value.level !== "unknown");
  const highestRisk = riskFindings.some((entry) => entry.type === "finding" && entry.value.level === "high") ? "HIGH" : riskFindings.length > 0 ? "MEDIUM" : "LOW";
  const risk = analysis.risk;
  if (risk.level === "Unknown") {
    if (risk.evidenceIds.length !== 0) fail("ai_claim_unsupported", "invalid_unknown", "risk.evidence_ids");
  } else if (risk.level === "CRITICAL") {
    requireData("risk.level", true);
    fail("ai_claim_unsupported", "unsupported_claim_type", "risk.level");
  } else {
    const selected = roles(risk.evidenceIds, risk.level === "LOW" ? [["quality"], ["total"]] : [["quality"], ["finding"], ["stat_ip", "stat_path", "stat_country", "stat_asn", "stat_allow", "stat_rate"]], "risk.evidence_ids");
    requireData("risk.level", true);
    if (risk.level !== highestRisk) fail("ai_claim_unsupported", "support_condition_failed", "risk.level");
    if (risk.level !== "LOW") {
      support(selected[2], selected[1], "risk.evidence_ids");
      const finding = selected[1];
      if (finding?.type !== "finding" || finding.value.level.toUpperCase() !== risk.level)
        fail("ai_claim_unsupported", "support_condition_failed", "risk.level");
    }
  }

  function botSupported(): boolean {
    const ua = entries.get("stat:ua");
    const uaFinding = entries.get("finding:user_agent_concentration");
    const rateFinding = entries.get("finding:request_rate");
    return assessable && ua?.type === "stat_ua" && ua.value.denominator >= 10 &&
      uaFinding?.type === "finding" && uaFinding.value.level === "high" &&
      rateFinding?.type === "finding" && rateFinding.value.level === "high";
  }
  const attack = analysis.attack;
  if (attack.type === "Unknown") {
    if (attack.confidence !== 0 || attack.evidenceIds.length !== 0) fail("ai_claim_unsupported", "invalid_unknown", "attack.evidence_ids");
  } else if (attack.type !== "Bot") {
    requireData("attack.type", true);
    fail("ai_claim_unsupported", "unsupported_claim_type", "attack.type");
  } else {
    const selected = roles(attack.evidenceIds, [["stat_ua"], ["finding"], ["stat_rate"], ["finding"]], "attack.evidence_ids");
    requireData("attack.type", true);
    // Finding order is immaterial: the statId establishes its role.
    const uaFinding = selected.find((entry) => entry.type === "finding" && entry.value.statId === selected[0]?.id);
    const rateFinding = selected.find((entry) => entry.type === "finding" && entry.value.statId === selected[2]?.id);
    support(selected[0], uaFinding, "attack.evidence_ids", true);
    support(selected[2], rateFinding, "attack.evidence_ids", true);
    if (!botSupported() || attack.confidence <= 0 || attack.confidence > 0.6) fail("ai_claim_unsupported", "support_condition_failed", "attack.confidence");
  }

  for (const observation of analysis.observations) {
    const path = "observations[].evidence_ids";
    const { kind, dimension, evidenceIds } = observation;
    const statTypes: Record<string, EntryType> = { ip: "stat_ip", path: "stat_path", country: "stat_country", asn: "stat_asn", allow: "stat_allow", block: "stat_block", challenge: "stat_challenge", rate: "stat_rate", ua: "stat_ua" };
    const allowed: Record<typeof kind, readonly string[]> = {
      aggregate_concentration: ["ip", "path", "country", "asn"], action_ratio: ["allow", "block", "challenge"],
      request_rate: ["rate"], sample_ua_concentration: ["ua"], sample_observed: ["sample"], insufficient_data: ["none"],
    };
    if (!allowed[kind].includes(dimension)) fail("ai_claim_unsupported", "support_condition_failed", "observations[].dimension");
    if (kind === "insufficient_data") {
      if (evidenceIds.length !== 0 || botSupported()) fail("ai_claim_unsupported", "invalid_unknown", path);
      continue;
    }
    if (kind === "sample_observed") { roles(evidenceIds, [["sample"]], path); continue; }
    const statType = statTypes[dimension];
    if (statType === undefined) fail("ai_claim_unsupported", "unsupported_claim_type", path);
    const expected: Role[] = [[statType]];
    if (dimension !== "challenge") expected.push(["finding"]);
    if (kind === "request_rate") expected.push(["context"]);
    else if (kind !== "sample_ua_concentration") expected.push(["total"]);
    const selected = roles(evidenceIds, expected, path);
    requireData(path);
    if (dimension !== "challenge") support(selected[0], selected[1], path);
    if (selected[0]?.type === "stat_ua" && selected[0].value.denominator <= 0) fail("ai_claim_unsupported", "support_condition_failed", path);
  }
  for (const recommendation of analysis.recommendations) {
    const path = "recommendations[].evidence_ids";
    const allowed: Record<typeof recommendation.kind, readonly Role[]> = {
      review_source: [["aggregate_ip", "aggregate_country", "aggregate_asn"]],
      review_target: [["aggregate_path", "aggregate_host"]],
      review_waf: [["stat_allow"], ["finding"], ["total"]],
      verify_sample: [["sample", "stat_ua"]], manual_dashboard: [["context"]],
    };
    const selected = roles(recommendation.evidenceIds, allowed[recommendation.kind], path);
    if (recommendation.kind === "review_waf") { requireData(path); support(selected[0], selected[1], path); }
    const first = selected[0];
    if (first !== undefined && (("count" in first.value && first.value.count <= 0) || (first.type === "stat_ua" && first.value.denominator <= 0)))
      fail("ai_claim_unsupported", "support_condition_failed", path);
  }
  const result = freeze({ analysis, catalog }) as ValidatedAIAnalysis;
  validatedResults.add(result);
  return result;
}

// Attach only schema-owned paths; never retain a Zod error or its input values.
function errorWithSafePaths(error: ReturnType<typeof validationError>, paths: readonly string[]) {
  return validationError(error.code, "schema", "invalid_shape", paths[0] ?? "root");
}
