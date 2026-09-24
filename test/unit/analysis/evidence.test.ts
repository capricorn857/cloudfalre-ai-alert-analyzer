import { describe, expect, it } from "vitest";
import { validateAIAnalysisEvidence } from "../../../src/analysis/evidence";
import { buildEvidenceCatalog } from "../../../src/analysis/evidence-catalog";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { calculateStatistics } from "../../../src/analysis/statistics";
import { evaluateRules } from "../../../src/analysis/rules";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { structuredAnalysis } from "../../fixtures/structured-ai";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";

function catalog(sampleCount = 2, bot = false) {
  const sample = snapshot.samples[0];
  if (sample === undefined) throw new Error("fixture");
  const incident = normalizeIncident(queueMessage, { ...snapshot, samples: Array.from({ length: sampleCount }, () => ({ ...sample })) });
  const statistics = calculateStatistics(incident);
  const findings = evaluateRules(statistics, bot ? { ...rulesConfig, requestRate: { medium: 0.01, high: 0.1 } } : rulesConfig);
  return buildEvidenceCatalog({ incident, statistics, findings });
}

function reject(analysis: AIAnalysis, code: string, reason?: string) {
  expect(() => validateAIAnalysisEvidence(analysis, catalog())).toThrow(expect.objectContaining({ code, ...(reason === undefined ? {} : { validationReason: reason }) }));
}

describe("structured evidence support", () => {
  it("accepts grounded observations and binds immutable inputs", () => {
    const result = validateAIAnalysisEvidence(structuredAnalysis(), catalog());
    expect(result.analysis.risk.level).toBe("HIGH");
    expect(Object.isFrozen(result.catalog.entries)).toBe(true);
    expect(Object.isFrozen(result.analysis.risk.evidenceIds)).toBe(true);
  });
  it.each([
    [["missing:0"], "ai_reference_invalid", "reference_not_found"],
    [["stat:path", "stat:path"], "ai_reference_invalid", "duplicate_reference"],
    [["stat:ip", "finding:path_concentration", "total:0"], "ai_reference_type_mismatch", "reference_type_mismatch"],
    [["stat:path", "total:0"], "ai_claim_unsupported", "missing_support"],
    [["stat:path", "finding:path_concentration", "total:0", "stat:ip"], "ai_claim_unsupported", "unrelated_reference"],
    [["stat:ua", "finding:user_agent_concentration", "total:0"], "ai_reference_type_mismatch", "reference_type_mismatch"],
  ] as const)("rejects incorrect evidence roles %j", (ids, code, reason) => {
    const analysis = structuredAnalysis();
    const observation = analysis.observations[0];
    if (observation === undefined) throw new Error("fixture");
    observation.evidenceIds = [...ids];
    reject(analysis, code, reason);
  });
  it.each(["Scanning", "Brute Force", "Credential Stuffing", "API Abuse", "Vulnerability Scanning"] as const)("rejects real path as proof of %s", (type) => {
    const analysis = structuredAnalysis();
    analysis.attack = { type, confidence: 0.5, evidenceIds: ["stat:path"] };
    reject(analysis, "ai_claim_unsupported", "unsupported_claim_type");
  });
  it("rejects CRITICAL and cherry-picked lower risk", () => {
    const analysis = structuredAnalysis();
    analysis.risk.level = "CRITICAL";
    reject(analysis, "ai_claim_unsupported");
    analysis.risk = { level: "MEDIUM", evidenceIds: ["quality:0", "finding:path_concentration", "stat:path"] };
    reject(analysis, "ai_claim_unsupported", "support_condition_failed");
    analysis.risk = { level: "LOW", evidenceIds: ["quality:0", "total:0"] };
    reject(analysis, "ai_claim_unsupported");
  });
  it("rejects duplicate observations and advice but permits cross-node reuse", () => {
    const analysis = structuredAnalysis();
    expect(() => validateAIAnalysisEvidence(analysis, catalog())).not.toThrow();
    const first = analysis.observations[0];
    const advice = analysis.recommendations[0];
    if (first === undefined || advice === undefined) throw new Error("fixture");
    analysis.observations.push(structuredClone(first));
    reject(analysis, "ai_reference_invalid", "duplicate_claim");
    analysis.observations.pop();
    analysis.recommendations.push(structuredClone(advice));
    reject(analysis, "ai_reference_invalid", "duplicate_recommendation");
  });
  it("allows Unknown only with no references and zero attack confidence", () => {
    const analysis = structuredAnalysis();
    analysis.risk = { level: "Unknown", evidenceIds: [] };
    expect(() => validateAIAnalysisEvidence(analysis, catalog())).not.toThrow();
    analysis.attack.confidence = 0.1;
    reject(analysis, "ai_claim_unsupported", "invalid_unknown");
    analysis.attack.confidence = 0;
    analysis.attack.evidenceIds = ["total:0"];
    reject(analysis, "ai_claim_unsupported", "invalid_unknown");
  });
  it("checks data sufficiency independently of existing references", () => {
    const data = catalog();
    const quality = data.entries.find((entry) => entry.type === "quality");
    if (quality?.type !== "quality") throw new Error("fixture");
    quality.value.riskAssessable = false;
    expect(() => validateAIAnalysisEvidence(structuredAnalysis(), data)).toThrow(expect.objectContaining({ code: "ai_data_insufficient" }));
  });
  it.each([9, 10])("enforces Bot sample support minimum (%i)", (samples) => {
    const analysis = structuredAnalysis();
    analysis.attack = { type: "Bot", confidence: 0.6, evidenceIds: ["stat:ua", "finding:user_agent_concentration", "stat:rate", "finding:request_rate"] };
    if (samples === 10) expect(() => validateAIAnalysisEvidence(analysis, catalog(samples, true))).not.toThrow();
    else expect(() => validateAIAnalysisEvidence(analysis, catalog(samples, true))).toThrow(expect.objectContaining({ code: "ai_claim_unsupported" }));
    for (const confidence of [0, 0.61]) {
      analysis.attack.confidence = confidence;
      expect(() => validateAIAnalysisEvidence(analysis, catalog(10, true))).toThrow();
    }
  });
  it.each([
    ["action_ratio", "challenge", ["stat:challenge", "total:0"]],
    ["request_rate", "rate", ["stat:rate", "finding:request_rate", "ctx:0"]],
    ["sample_ua_concentration", "ua", ["stat:ua", "finding:user_agent_concentration"]],
    ["sample_observed", "sample", ["sample:0"]],
    ["insufficient_data", "none", []],
  ] as const)("accepts supported observation %s", (kind, dimension, ids) => {
    const analysis = structuredAnalysis();
    analysis.observations = [{ kind, dimension, evidenceIds: [...ids] }];
    expect(() => validateAIAnalysisEvidence(analysis, catalog())).not.toThrow();
  });
  it.each([
    ["review_source", ["agg:ip:0"]], ["review_target", ["agg:path:0"]],
    ["review_waf", ["stat:allow", "finding:allow_ratio", "total:0"]],
    ["verify_sample", ["sample:0"]], ["verify_sample", ["stat:ua"]],
  ] as const)("requires scoped evidence for advice %s", (kind, ids) => {
    const analysis = structuredAnalysis();
    analysis.recommendations = [{ kind, evidenceIds: [...ids] }];
    expect(() => validateAIAnalysisEvidence(analysis, catalog())).not.toThrow();
    analysis.recommendations = [{ kind, evidenceIds: [] }];
    reject(analysis, "ai_claim_unsupported", "missing_support");
  });

  it.each(["ip", "path", "country", "asn"] as const)("supports only the matching %s concentration", (dimension) => {
    const analysis = structuredAnalysis();
    analysis.observations = [{ kind: "aggregate_concentration", dimension,
      evidenceIds: [`stat:${dimension}`, `finding:${dimension}_concentration`, "total:0"] }];
    expect(() => validateAIAnalysisEvidence(analysis, catalog())).not.toThrow();
    analysis.observations = [{ kind: "aggregate_concentration", dimension,
      evidenceIds: [`stat:${dimension}`, "finding:allow_ratio", "total:0"] }];
    reject(analysis, "ai_claim_unsupported", "support_condition_failed");
  });

  it("accepts LOW only when no risk rule fired, and MEDIUM only when highest", () => {
    const incident = normalizeIncident(queueMessage, snapshot);
    const statistics = calculateStatistics(incident);
    const quietRules = Object.fromEntries(Object.keys(rulesConfig).map((key) => [key, { medium: 1000, high: 2000 }])) as unknown as typeof rulesConfig;
    const lowCatalog = buildEvidenceCatalog({ incident, statistics, findings: evaluateRules(statistics, quietRules) });
    const analysis = structuredAnalysis();
    analysis.risk = { level: "LOW", evidenceIds: ["quality:0", "total:0"] };
    analysis.observations = [];
    expect(() => validateAIAnalysisEvidence(analysis, lowCatalog)).not.toThrow();
    const mediumCatalog = buildEvidenceCatalog({ incident, statistics, findings: [
      { type: "path_concentration", level: "medium", value: statistics.topPath?.ratio ?? 0, threshold: 30, evidence: "program" },
    ] });
    analysis.risk = { level: "MEDIUM", evidenceIds: ["quality:0", "finding:path_concentration", "stat:path"] };
    expect(() => validateAIAnalysisEvidence(analysis, mediumCatalog)).not.toThrow();
  });

  it("rejects malformed finding support and incorrect observation dimensions", () => {
    const data = catalog();
    const entry = data.entries.find((item) => item.id === "finding:path_concentration");
    if (entry?.type !== "finding") throw new Error("fixture");
    entry.value.threshold = 99;
    expect(() => validateAIAnalysisEvidence(structuredAnalysis(), data)).toThrow(expect.objectContaining({ code: "ai_catalog_invalid" }));
    const analysis = structuredAnalysis();
    analysis.observations = [{ kind: "sample_observed", dimension: "path", evidenceIds: ["sample:0"] }];
    reject(analysis, "ai_claim_unsupported");
  });

  it("keeps all-unknown and zero-event inputs in Unknown", () => {
    const incident = normalizeIncident(queueMessage, { ...snapshot, totalEvents: 0, topIps: [], topPaths: [], topCountries: [], topAsns: [], actions: [], samples: [] });
    const statistics = calculateStatistics(incident);
    const data = buildEvidenceCatalog({ incident, statistics, findings: evaluateRules(statistics, rulesConfig) });
    const analysis = structuredAnalysis();
    analysis.risk = { level: "Unknown", evidenceIds: [] };
    analysis.observations = [{ kind: "insufficient_data", dimension: "none", evidenceIds: [] }];
    expect(() => validateAIAnalysisEvidence(analysis, data)).not.toThrow();
    analysis.risk = { level: "LOW", evidenceIds: ["quality:0", "total:0"] };
    expect(() => validateAIAnalysisEvidence(analysis, data)).toThrow(expect.objectContaining({ code: "ai_data_insufficient" }));
  });
});
