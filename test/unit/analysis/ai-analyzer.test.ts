import { describe, expect, it, vi } from "vitest";
import { runAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { hostFromSnapshot } from "../../fixtures/host-analysis";
import { makeHostAIResponse } from "../../fixtures/host-ai";
import { rememberCompletionDiagnostics } from "../../../src/observability/ai-diagnostics";
import { AppError } from "../../../src/observability/errors";

async function collect() {
  return analyzeWafAlert(structuredClone(queueMessage), { discoverZone: () => Promise.resolve({ zoneTotalEvents: 400, topHosts: [{ host: "example.test", count: 400 }] }), collectHostSnapshot: () => Promise.resolve(hostFromSnapshot(snapshot)) }, rulesConfig);
}
describe("runAIAnalysis Host contract", () => {
  it("validates successful Host output and preserves catalog binding", async () => {
    const analyzeHosts = vi.fn().mockResolvedValue(makeHostAIResponse());
    const result = await runAIAnalysis(await collect(), { analyzeHosts });
    expect(result).toMatchObject({ status: "available", hosts: [{ hostId: "h0", status: "available" }], catalog: { version: 2 } });
    expect(analyzeHosts).toHaveBeenCalledOnce();
    const host = result.hosts[0];
    if (host?.status !== "available") throw new Error("expected available");
    expect(Object.isFrozen(host.analysis.catalog)).toBe(true);
  });
  it("degrades transport failures without exposing exception messages", async () => {
    const result = await runAIAnalysis(await collect(), { analyzeHosts: vi.fn().mockRejectedValue(new AppError("llm_timeout", "SENSITIVE", true)) });
    expect(result).toMatchObject({ status: "unavailable", failure: { errorCode: "llm_timeout" } });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE");
  });
  it("enforces support even when a replacement client claims the output is valid", async () => {
    const output = makeHostAIResponse();
    const host = output.hosts[0];
    if (host?.status !== "valid") throw new Error("fixture");
    host.analysis.attack = { type: "Brute Force", confidence: 0.5, evidence_ids: ["h0:agg:path:0"] };
    rememberCompletionDiagnostics(output, { durationMs: 50, completionTokens: 77, finishReason: "stop" });
    const result = await runAIAnalysis(await collect(), { analyzeHosts: () => Promise.resolve(output) });
    expect(result).toMatchObject({ status: "unavailable", hosts: [{ reason: "ai_claim_unsupported", failure: { completionTokens: 77, durationMs: 50, validationReason: "unsupported_claim_type" } }] });
  });
  it("isolates catalog derivation failure before calling the provider", async () => {
    const result = await collect();
    if (result.status === "collection_failed") throw new Error("fixture");
    result.message.alert.resource = "x".repeat(2049);
    const analyzeHosts = vi.fn();
    expect(await runAIAnalysis(result, { analyzeHosts })).toMatchObject({ status: "unavailable", failure: { failureSource: "catalog", errorCode: "ai_catalog_invalid" } });
    expect(analyzeHosts).not.toHaveBeenCalled();
  });
  it("does not let a client mutate the trusted catalog", async () => {
    const result = await runAIAnalysis(await collect(), { analyzeHosts: (catalog) => {
      catalog.entries.length = 0;
      return Promise.resolve(makeHostAIResponse());
    } });
    expect(result.status).toBe("available");
    expect(result.catalog?.entries.length).toBeGreaterThan(0);
  });
  it("skips AI for discovery failure and empty data", async () => {
    const analyzeHosts = vi.fn();
    const failure = await analyzeWafAlert(queueMessage, { discoverZone: () => Promise.reject(new Error("failure")), collectHostSnapshot: vi.fn() }, rulesConfig);
    expect(await runAIAnalysis(failure, { analyzeHosts })).toMatchObject({ status: "unavailable", hosts: [] });
    const empty = await analyzeWafAlert(queueMessage, { discoverZone: () => Promise.resolve({ zoneTotalEvents: 0, topHosts: [] }), collectHostSnapshot: vi.fn() }, rulesConfig);
    expect(await runAIAnalysis(empty, { analyzeHosts })).toMatchObject({ status: "unavailable", hosts: [] });
    expect(analyzeHosts).not.toHaveBeenCalled();
  });
  it("rejects duplicate or unknown response host identities globally", async () => {
    const output = makeHostAIResponse();
    const first = output.hosts[0];
    if (first === undefined) throw new Error("fixture");
    output.hosts.push(first);
    expect(await runAIAnalysis(await collect(), { analyzeHosts: () => Promise.resolve(output) })).toMatchObject({ status: "unavailable", failure: { errorCode: "llm_output_schema_invalid" } });
  });
});
