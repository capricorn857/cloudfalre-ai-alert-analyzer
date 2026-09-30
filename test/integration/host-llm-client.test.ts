import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../../src/clients/llm";
import { buildHostEvidenceCatalog } from "../../src/analysis/host-evidence";
import { analyzeHost } from "../../src/analysis/host-analysis";
import { makeHost, hostWindow } from "../fixtures/host-analysis";
import { rulesConfig, queueMessage } from "../fixtures/domain";

const catalog = buildHostEvidenceCatalog({ message: { ...queueMessage, analysisWindow: hostWindow }, zoneTotalEvents: 1000, hosts: [analyzeHost(makeHost(), 1000, hostWindow, rulesConfig)] });
const valid = { host_id: "h0", risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] }, observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: ["h0:ctx:0"] }] };
const completion = (output: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] }));
const options = { baseUrl: "https://llm.test/v1", model: "test", apiKey: "test", timeoutMs: 1000, maxOutputTokens: 2048 };

describe("bounded multi Host LLM", () => {
  it("sends one v3 request and returns a per Host validated shape", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion({ schema_version: 3, hosts: [valid] }));
    expect(await new LLMClient({ ...options, fetchFn }).analyzeHosts(catalog)).toMatchObject({ hosts: [{ hostId: "h0", status: "valid" }] });
    expect(fetchFn).toHaveBeenCalledOnce();
    const body = fetchFn.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("Expected JSON");
    expect(body).toContain('"const":3');
    expect(body).toContain('"version":2'.replaceAll('"', '\\"'));
  });
  it("keeps identifiable host schema failures local but rejects duplicate identities", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(completion({ schema_version: 3, hosts: [{ ...valid, summary: "MODEL_SENTINEL" }] })).mockResolvedValueOnce(completion({ schema_version: 3, hosts: [valid, valid] }));
    const client = new LLMClient({ ...options, fetchFn });
    expect(await client.analyzeHosts(catalog)).toMatchObject({ hosts: [{ hostId: "h0", status: "invalid" }] });
    await expect(client.analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_output_schema_invalid" });
  });
  it("rejects v2 and oversized response content without retry", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(completion({ schema_version: 2, ...valid })).mockResolvedValueOnce(completion("x".repeat(33 * 1024)));
    const client = new LLMClient({ ...options, fetchFn });
    await expect(client.analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_output_schema_invalid" });
    await expect(client.analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_output_truncated" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("rejects a request body over budget without calling the provider", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(new LLMClient({ ...options, model: "m".repeat(97 * 1024), fetchFn }).analyzeHosts(catalog)).rejects.toMatchObject({ code: "ai_input_budget_exceeded" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("rejects an oversized protocol envelope even when its completion is valid", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ padding: "x".repeat(129 * 1024), choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ schema_version: 3, hosts: [valid] }) } }] }));
    await expect(new LLMClient({ ...options, fetchFn }).analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_response_invalid" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("checks serialized message size after escaping catalog strings", async () => {
    const candidates = [400, 600, 800, 1000, 1200, 1600, 1900].map((length) => buildHostEvidenceCatalog({
      message: { ...queueMessage, analysisWindow: hostWindow }, zoneTotalEvents: 4000,
      hosts: Array.from({ length: 5 }, (_, index) => {
        const raw = makeHost("h" + String(index), "host" + String(index) + ".example.test", 600);
        if (raw.aggregates === null) throw new Error("fixture");
        const first = raw.aggregates.topPaths[0];
        if (first === undefined) throw new Error("fixture");
        raw.aggregates.topPaths = [first, ...Array.from({ length: 4 }, (_, rank) => ({ value: "/" + String(rank) + '"'.repeat(length), count: 1 }))];
        return analyzeHost(raw, 4000, hostWindow, rulesConfig);
      }),
    }));
    const oversized = candidates.find((value) => new TextEncoder().encode(JSON.stringify([{ role: "user", content: JSON.stringify(value) }])).byteLength > 64 * 1024);
    expect(oversized).toBeDefined();
    if (oversized === undefined) throw new Error("fixture must exercise message budget");
    const fetchFn = vi.fn<typeof fetch>();
    await expect(new LLMClient({ ...options, fetchFn }).analyzeHosts(oversized)).rejects.toMatchObject({ code: "ai_input_budget_exceeded" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
