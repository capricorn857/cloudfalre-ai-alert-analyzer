import { attentionCounts } from "../../fixtures/blocked-events";
import { describe, expect, it, vi } from "vitest";
import { runHostAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { analyzeHostWafAlert } from "../../../src/analyzers/waf-analyzer";
import { makeHost } from "../../fixtures/host-analysis";
import { queueMessage, rulesConfig } from "../../fixtures/domain";
import type { HostAIAnalysisWire } from "../../../src/domain/ai-analysis";

const unknown = (hostId: string): HostAIAnalysisWire => ({ host_id: hostId, risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] }, observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: [`${hostId}:ctx:0`] }] });
async function snapshot() {
  return analyzeHostWafAlert(queueMessage, {
    discoverZone: () => Promise.resolve({ ...attentionCounts(1000), topHosts: [{ host: "example.test", count: 600 }, { host: "www.example.test", count: 300 }] }),
    collectHostSnapshot: (_input, host) => Promise.resolve(makeHost(host.hostId, host.host, host.discoveryCount)),
  }, rulesConfig);
}

describe("Host AI failure isolation", () => {
  it("keeps the valid Host when the other Host has invalid support", async () => {
    const client = { analyzeHosts: vi.fn().mockResolvedValue({ hosts: [
      { hostId: "h0", status: "valid", analysis: unknown("h0") },
      { hostId: "h1", status: "valid", analysis: { ...unknown("h1"), recommendations: [{ kind: "review_source", evidence_ids: ["h0:agg:ip:0"] }] } },
    ] }) };
    const result = await runHostAIAnalysis(await snapshot(), client);
    expect(result).toMatchObject({ status: "partial", hosts: [{ hostId: "h0", status: "available" }, { hostId: "h1", status: "unavailable", reason: "ai_reference_invalid" }] });
    expect(client.analyzeHosts).toHaveBeenCalledOnce();
  });
  it("falls back all Hosts on client failure without collecting again", async () => {
    const client = { analyzeHosts: vi.fn().mockRejectedValue(new Error("MODEL_SENTINEL")) };
    const result = await runHostAIAnalysis(await snapshot(), client);
    expect(result.status).toBe("unavailable");
    expect(result.hosts).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("MODEL_SENTINEL");
  });
  it("degrades only a missing Host response", async () => {
    const result = await runHostAIAnalysis(await snapshot(), { analyzeHosts: () => Promise.resolve({ hosts: [{ hostId: "h0", status: "valid", analysis: unknown("h0") }] }) });
    expect(result).toMatchObject({ status: "partial", hosts: [{ hostId: "h0", status: "available" }, { hostId: "h1", status: "unavailable", reason: "ai_host_missing" }] });
  });
});
