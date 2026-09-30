import { buildHostEvidenceCatalog } from "../../src/analysis/host-evidence";
import { analyzeHost } from "../../src/analysis/host-analysis";
import { queueMessage, rulesConfig } from "./domain";
import { makeHost } from "./host-analysis";
import type { MultiHostAIResponse } from "../../src/domain/ai-analysis";

export function makeHostAIResponse(): MultiHostAIResponse {
  return { hosts: [{ hostId: "h0", status: "valid", analysis: { host_id: "h0",
    risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] },
    observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: ["h0:ctx:0"] }],
  } }] };
}

export function makeHostCatalog() {
  return buildHostEvidenceCatalog({ message: queueMessage, zoneTotalEvents: 1000,
    hosts: [analyzeHost(makeHost(), 1000, queueMessage.analysisWindow, rulesConfig)] });
}

// Construct fictional v3 cases from policy fixtures; production never converts old responses.
export function hostWireFixture(single: Record<string, unknown>, hostId = "h0") {
  const result = structuredClone(single);
  delete result.schema_version;
  const prefixNode = (node: unknown): unknown => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return node;
    const value = node as Record<string, unknown>;
    return { ...value, ...(Array.isArray(value.evidence_ids) ? { evidence_ids: value.evidence_ids.map((id: unknown) => typeof id === "string" ? `${hostId}:${id}` : id) } : {}) };
  };
  return { schema_version: 3, hosts: [{ ...result, host_id: hostId,
    risk: prefixNode(result.risk), attack: prefixNode(result.attack),
    observations: Array.isArray(result.observations) ? result.observations.map(prefixNode) : result.observations,
    recommendations: Array.isArray(result.recommendations) ? result.recommendations.map(prefixNode) : result.recommendations,
  }] };
}
