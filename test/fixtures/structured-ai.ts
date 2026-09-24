import { AIAnalysisSchema } from "../../src/domain/ai-analysis";

export function structuredAnalysis() {
  return AIAnalysisSchema.parse({
    schemaVersion: 2,
    risk: { level: "HIGH", evidenceIds: ["quality:0", "finding:allow_ratio", "stat:allow"] },
    attack: { type: "Unknown", confidence: 0, evidenceIds: [] },
    observations: [
      { kind: "aggregate_concentration", dimension: "path", evidenceIds: ["stat:path", "finding:path_concentration", "total:0"] },
      { kind: "action_ratio", dimension: "allow", evidenceIds: ["stat:allow", "finding:allow_ratio", "total:0"] },
    ],
    recommendations: [{ kind: "manual_dashboard", evidenceIds: ["ctx:0"] }],
  });
}
