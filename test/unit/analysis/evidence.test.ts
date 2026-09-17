import { describe, expect, it } from "vitest";

import { validateAIAnalysisEvidence } from "../../../src/analysis/evidence";
import { AIAnalysisSchema } from "../../../src/domain/ai-analysis";
import inventedOutput from "../../fixtures/llm/invented-output.json";
import validOutput from "../../fixtures/llm/valid-output.json";
import { calculateStatistics } from "../../../src/analysis/statistics";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { evaluateRules } from "../../../src/analysis/rules";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";

const incident = normalizeIncident(queueMessage, snapshot);
const statistics = calculateStatistics(incident);
const findings = evaluateRules(statistics, rulesConfig);

function toInternal(output: typeof validOutput) {
  return AIAnalysisSchema.parse({
    riskLevel: output.risk_level,
    attackType: output.attack_type,
    confidence: output.confidence,
    summary: output.summary,
    evidence: output.evidence,
    recommendations: output.recommendations,
  });
}

describe("validateAIAnalysisEvidence", () => {
  it("accepts entities present in Incident and Statistics", () => {
    expect(() => {
      validateAIAnalysisEvidence(toInternal(validOutput), { incident, statistics, findings });
    }).not.toThrow();
  });

  it("rejects invented entities and automatic action claims", () => {
    expect(() => {
      validateAIAnalysisEvidence(toInternal(inventedOutput), { incident, statistics, findings });
    }).toThrow(/ai_evidence_invalid/u);
  });

  it("requires Unknown when all evidence is insufficient", () => {
    const unknownFindings = findings.map((finding) => ({
      ...finding,
      level: "unknown" as const,
      value: null,
      threshold: null,
      evidence: "Insufficient data",
    }));
    expect(() => {
      validateAIAnalysisEvidence(toInternal(validOutput), {
        incident: { ...incident, totalEvents: 0 },
        statistics: { ...statistics, dataSufficient: false },
        findings: unknownFindings,
      });
    }).toThrow(/ai_evidence_invalid/u);
  });
});
