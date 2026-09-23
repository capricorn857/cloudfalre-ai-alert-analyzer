import { describe, expect, it } from "vitest";

import { validateAIAnalysisEvidence } from "../../../src/analysis/evidence";
import { AIAnalysisSchema } from "../../../src/domain/ai-analysis";
import inventedOutput from "../../fixtures/llm/invented-output.json";
import validOutput from "../../fixtures/llm/valid-output.json";
import { calculateStatistics } from "../../../src/analysis/statistics";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { evaluateRules } from "../../../src/analysis/rules";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { AppError } from "../../../src/observability/errors";

const incident = normalizeIncident(queueMessage, snapshot);
const statistics = calculateStatistics(incident);
const findings = evaluateRules(statistics, rulesConfig);

function toInternal(output: {
  risk_level: string;
  attack_type: string;
  confidence: number;
  summary: string;
  evidence: string[];
  recommendations: string[];
}) {
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
  it.each(["summary", "evidence", "recommendations"] as const)(
    "classifies unsupported IP, path and ASN in %s without retaining their values",
    (field) => {
      for (const entity of ["203.0.113.99", "/private-sentinel", "AS65530"]) {
        const analysis = toInternal(validOutput);
        const error = catchError(() => {
          validateAIAnalysisEvidence({
            ...analysis,
            [field]: field === "summary" ? entity : [entity],
          }, { incident, statistics, findings });
        });
        expect(error).toMatchObject({
          code: "ai_evidence_invalid", retryable: false,
          evidenceFailureReason: "unsupported_entity",
        });
        expect(JSON.stringify(error)).not.toContain(entity);
        expect(error.message).toBe("ai_evidence_invalid");
      }
    },
  );

  it.each([
    "already blocked", "already banned", "already modified", "already updated", "already changed",
    "blocked successfully", "banned automatically", "已封禁", "已修改",
  ])("classifies the existing action rule: %s", (claim) => {
    const error = catchError(() => {
      validateAIAnalysisEvidence({
        ...toInternal(validOutput), summary: claim,
      }, { incident, statistics, findings });
    });
    expect(error).toMatchObject({ evidenceFailureReason: "automatic_action_claim", retryable: false });
  });

  it.each([false, true])("requires Unknown independently for insufficient data or unknown findings (%s)", (allUnknown) => {
    const input = {
      incident,
      statistics: { ...statistics, dataSufficient: allUnknown },
      findings: allUnknown ? findings.map((finding) => ({ ...finding, level: "unknown" as const })) : findings,
    };
    const analysis = toInternal(validOutput);
    const error = catchError(() => {
      validateAIAnalysisEvidence(analysis, input);
    });
    expect(error).toMatchObject({
      evidenceFailureReason: "insufficient_data", retryable: false,
    });
    expect(() => {
      validateAIAnalysisEvidence({ ...analysis, attackType: "Unknown" }, input);
    }).not.toThrow();
  });

  it("preserves guidance and existing reported-state wording", () => {
    expect(() => {
      validateAIAnalysisEvidence({
      ...toInternal(validOutput), summary: "Traffic includes blocked events.",
      recommendations: ["Review whether configuration needs review."],
      }, { incident, statistics, findings });
    }).not.toThrow();
  });

  it("continues accepting sample-only entities", () => {
    const sample = incident.samples[0];
    if (sample === undefined) throw new Error("expected sample fixture");
    expect(() => {
      validateAIAnalysisEvidence({
      ...toInternal(validOutput), summary: "192.0.2.77 /sample-only AS65530",
    }, {
      incident: { ...incident, samples: [{ ...sample, clientIP: "192.0.2.77", clientRequestPath: "/sample-only", clientAsn: "65530" }] },
      statistics, findings,
      });
    }).not.toThrow();
  });

  it("accepts entities present in Incident and Statistics", () => {
    expect(() => {
      validateAIAnalysisEvidence(toInternal(validOutput), { incident, statistics, findings });
    }).not.toThrow();
  });

  it("rejects invented entities and automatic action claims", () => {
    const error = catchError(() => {
      validateAIAnalysisEvidence(toInternal(inventedOutput), { incident, statistics, findings });
    });
    expect(error).toMatchObject({ code: "ai_evidence_invalid", evidenceFailureReason: "unsupported_entity" });
  });

  it("classifies automatic action claims without exposing the action text", () => {
    const error = catchError(() => {
      validateAIAnalysisEvidence(
        toInternal({ ...validOutput, recommendations: ["The existing rule already blocked /api/login successfully."] }),
        { incident, statistics, findings },
      );
    });
    expect(error).toMatchObject({ code: "ai_evidence_invalid", evidenceFailureReason: "automatic_action_claim" });
  });

  it("requires Unknown when all evidence is insufficient", () => {
    const unknownFindings = findings.map((finding) => ({
      ...finding,
      level: "unknown" as const,
      value: null,
      threshold: null,
      evidence: "Insufficient data",
    }));
    const error = catchError(() => {
      validateAIAnalysisEvidence(toInternal(validOutput), {
        incident: { ...incident, totalEvents: 0 },
        statistics: { ...statistics, dataSufficient: false },
        findings: unknownFindings,
      });
    });
    expect(error).toMatchObject({ code: "ai_evidence_invalid", evidenceFailureReason: "insufficient_data" });
  });
});

function catchError(action: () => void): AppError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected validation to fail");
}
