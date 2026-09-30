import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LLMClient } from "../../src/clients/llm";
import { MultiHostAIWireSchema } from "../../src/domain/ai-analysis";
import type { HostEvidenceCatalog } from "../../src/domain/host-evidence";
import { makeHostAIResponse, makeHostCatalog } from "../fixtures/host-ai";
import legacyOutput from "../fixtures/llm/legacy-output.json";

const catalog = makeHostCatalog();
const item = makeHostAIResponse().hosts[0];
if (item?.status !== "valid") throw new Error("fixture invalid");
const validHost = item.analysis;
const validOutput = { schema_version: 3, hosts: [validHost] };
afterEach(() => vi.unstubAllGlobals());
function completion(content: string, options: { finishReason?: string; refusal?: string | null; usage?: Record<string, unknown> } = {}): Response {
  return Response.json({ choices: [{ finish_reason: options.finishReason ?? "stop", message: { content, ...(options.refusal === undefined ? {} : { refusal: options.refusal }) } }], ...(options.usage === undefined ? {} : { usage: options.usage }) });
}
function makeClient(fetchFn: typeof fetch): LLMClient {
  return new LLMClient({ baseUrl: "https://llm.example.test/v1/", model: "test-model", apiKey: "llm-test-secret", fetchFn, timeoutMs: 1000, maxOutputTokens: 2048 });
}
function requestBody(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  const body = fetchFn.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected string body");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("LLMClient v3", () => {
  it("uses the v3 Zod schema verbatim and bounded catalog input", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(validOutput)));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).resolves.toMatchObject({ hosts: [{ hostId: "h0", status: "valid", analysis: validHost }] });
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({ model: "test-model", max_completion_tokens: 2048, response_format: { type: "json_schema", json_schema: { strict: true, schema: z.toJSONSchema(MultiHostAIWireSchema) } } });
    const messages = body.messages as { role: string; content: string }[];
    expect(JSON.parse(messages[1]?.content ?? "null")).toEqual(catalog);
    for (const text of ["same host", "Do not infer relationships", "CRITICAL risk is unsupported", "UA denominator >= 10 and confidence > 0 and <= 0.6", "quality + one highest-level risk finding", "LOW risk: quality + total", "matching stat + matching medium/high finding + total", "sample_observed: exactly one sample", "manual_dashboard: context"]) expect(messages[0]?.content).toContain(text);
    expect(JSON.stringify(body)).not.toContain("llm-test-secret");
  });
  it("rejects invalid Catalog input before fetching", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const invalid = { ...catalog, extension: "SENSITIVE" } as unknown as HostEvidenceCatalog;
    const error = await makeClient(fetchFn).analyzeHosts(invalid).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ai_catalog_invalid", validationStage: "catalog", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(JSON.stringify(error)).not.toContain("SENSITIVE");
  });
  it.each([legacyOutput, { ...validOutput, extension: true }, { schema_version: 2, hosts: [validHost] }, { schema_version: 3, hosts: [validHost, validHost] }, { schema_version: 3, hosts: [{ ...validHost, host_id: "h4" }] }])("rejects invalid root and ownership %j", async (output) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(output)));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_output_schema_invalid", validationStage: "schema" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it.each([
    { ...validHost, risk: { ...validHost.risk, rationale: "SENSITIVE" } },
    { ...validHost, risk: { ...validHost.risk, level: "SEVERE" } },
    { ...validHost, attack: { ...validHost.attack, confidence: -0.01 } },
    { ...validHost, attack: { ...validHost.attack, confidence: 1.01 } },
    { ...validHost, risk: { ...validHost.risk, evidence_ids: ["BAD-ID"] } },
    { ...validHost, risk: { ...validHost.risk, evidence_ids: ["a".repeat(65)] } },
    { ...validHost, risk: { ...validHost.risk, evidence_ids: ["a", "b", "c", "d", "e"] } },
    { ...validHost, observations: Array.from({ length: 4 }, () => ({ kind: "insufficient_data", dimension: "none", evidence_ids: [] })) },
    { ...validHost, recommendations: [] },
    { ...validHost, recommendations: Array.from({ length: 3 }, () => validHost.recommendations[0]) },
  ])("keeps known-Host shape errors local without raw fields", async (host) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify({ schema_version: 3, hosts: [host] })));
    const result = await makeClient(fetchFn).analyzeHosts(catalog);
    expect(result.hosts).toEqual([{ hostId: "h0", status: "invalid", errorCode: "llm_output_schema_invalid" }]);
    expect(JSON.stringify(result)).not.toContain("SENSITIVE");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("leaves reference support to the domain validator", async () => {
    const host = { ...validHost, risk: { level: "HIGH", evidence_ids: ["h0:quality:0", "h0:finding:not_real", "h0:stat:allow"] } };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify({ schema_version: 3, hosts: [host] })));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).resolves.toMatchObject({ hosts: [{ status: "valid" }] });
  });
  it("keeps parsing, truncation and refusal diagnostics safe", async () => {
    const malformed = await makeClient(vi.fn<typeof fetch>().mockResolvedValue(completion("SENSITIVE"))).analyzeHosts(catalog).catch((error: unknown) => error);
    expect(malformed).toMatchObject({ code: "llm_output_not_json", validationReason: "invalid_json" });
    expect(JSON.stringify(malformed)).not.toContain("SENSITIVE");
    const length = await makeClient(vi.fn<typeof fetch>().mockResolvedValue(completion("not-json", { finishReason: "length", usage: { completion_tokens: 2048, reasoning_tokens: 123 } }))).analyzeHosts(catalog).catch((error: unknown) => error);
    expect(length).toMatchObject({ code: "llm_output_truncated", completionTokens: 2048, reasoningTokens: 123 });
    const refusal = await makeClient(vi.fn<typeof fetch>().mockResolvedValue(completion("", { refusal: "SENSITIVE", finishReason: "SENSITIVE" }))).analyzeHosts(catalog).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "llm_refused", finishReason: "unknown", refusalPresent: true });
    expect(JSON.stringify(refusal)).not.toContain("SENSITIVE");
  });
  it.each([429, 503])("retries HTTP %i only once", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status })).mockResolvedValueOnce(completion(JSON.stringify(validOutput)));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).resolves.toMatchObject({ hosts: [{ status: "valid" }] });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(fetchFn.mock.calls[1]?.[1]?.body);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBe(fetchFn.mock.calls[1]?.[1]?.signal);
  });
  it.each([400, 401, 403])("does not retry HTTP %i", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("failure", { status }));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).rejects.toMatchObject({ httpStatus: status, retryable: false });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("does not repair invalid output after a transient retry", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 429 })).mockResolvedValueOnce(completion("not-json"));
    await expect(makeClient(fetchFn).analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_output_not_json", retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
  it("stops exhausted retries and preserves transport/protocol classifications", async () => {
    const busy = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response("busy", { status: 503 })));
    await expect(makeClient(busy).analyzeHosts(catalog)).rejects.toMatchObject({ httpStatus: 503 });
    expect(busy).toHaveBeenCalledTimes(2);
    for (const [error, code] of [[new DOMException("SENSITIVE", "TimeoutError"), "llm_timeout"], [new TypeError("SENSITIVE"), "llm_network"]] as const) {
      const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(makeClient(fetchFn).analyzeHosts(catalog)).rejects.toMatchObject({ code });
      expect(fetchFn).toHaveBeenCalledOnce();
    }
    await expect(makeClient(vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid"))).analyzeHosts(catalog)).rejects.toMatchObject({ code: "llm_response_invalid" });
  });
  it("calls default Workers Fetch with no invalid receiver", async () => {
    const fetchFn = vi.fn(function (this: unknown): Promise<Response> { expect(this).toBeUndefined(); return Promise.resolve(completion(JSON.stringify(validOutput))); });
    vi.stubGlobal("fetch", fetchFn);
    await new LLMClient({ baseUrl: "https://llm.test", model: "test", apiKey: "test", timeoutMs: 1000, maxOutputTokens: 2048 }).analyzeHosts(catalog);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
