import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AIAnalysisWireSchema, AIAnalysisSchema, toAIAnalysis } from "../../../src/domain/ai-analysis";

const output = {
  schema_version: 2,
  risk: { level: "Unknown", evidence_ids: [] },
  attack: { type: "Unknown", confidence: 0, evidence_ids: [] },
  observations: [],
  recommendations: [{ kind: "manual_dashboard", evidence_ids: ["ctx:0"] }],
};

describe("closed structured AI contract", () => {
  it("maps the wire contract into the strict internal contract", () => {
    const result = toAIAnalysis(AIAnalysisWireSchema.parse(output));
    expect(result).toEqual({ schemaVersion: 2, risk: { level: "Unknown", evidenceIds: [] },
      attack: { type: "Unknown", confidence: 0, evidenceIds: [] }, observations: [],
      recommendations: [{ kind: "manual_dashboard", evidenceIds: ["ctx:0"] }] });
    expect(AIAnalysisSchema.parse(result)).toEqual(result);
  });

  it.each(["summary", "evidence", "text", "rationale", "ip", "count"])("rejects free facts in %s", (key) => {
    expect(AIAnalysisWireSchema.safeParse({ ...output, [key]: "UNTRUSTED" }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, attack: { ...output.attack, [key]: "UNTRUSTED" } }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, recommendations: [{ ...output.recommendations[0], [key]: "UNTRUSTED" }] }).success).toBe(false);
  });

  it("enforces numerical, collection and identifier bounds", () => {
    for (const confidence of [-1, 1.1]) expect(AIAnalysisWireSchema.safeParse({ ...output, attack: { ...output.attack, confidence } }).success).toBe(false);
    for (const id of ["", "x".repeat(65), "/index.php", "ID"])
      expect(AIAnalysisWireSchema.safeParse({ ...output, recommendations: [{ kind: "manual_dashboard", evidence_ids: [id] }] }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, risk: { level: "HIGH", evidence_ids: Array(5).fill("ctx:0") } }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, recommendations: [] }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, recommendations: Array(4).fill(output.recommendations[0]) }).success).toBe(false);
    const observation = { kind: "insufficient_data", dimension: "none", evidence_ids: [] };
    expect(AIAnalysisWireSchema.safeParse({ ...output, observations: Array(7).fill(observation) }).success).toBe(false);
    expect(AIAnalysisWireSchema.safeParse({ ...output, risk: { ...output.risk, level: "SEVERE" } }).success).toBe(false);
  });

  it("exports a provider schema without transforms and with closed nested objects", () => {
    const schema = z.toJSONSchema(AIAnalysisWireSchema);
    expect(schema).toMatchObject({ additionalProperties: false, required: ["schema_version", "risk", "attack", "observations", "recommendations"] });
    expect(schema.properties?.risk).toMatchObject({ additionalProperties: false });
    expect(schema.properties?.attack).toMatchObject({ additionalProperties: false });
    expect(schema.properties?.recommendations).toMatchObject({ minItems: 1, maxItems: 3 });
  });
});
