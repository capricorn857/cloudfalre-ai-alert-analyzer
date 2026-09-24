import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LLMClient } from "../../src/clients/llm";
import { AIAnalysisWireSchema } from "../../src/domain/ai-analysis";
import { EvidenceCatalogSchema, type EvidenceCatalog } from "../../src/domain/evidence-catalog";
import { AppError } from "../../src/observability/errors";
import inventedOutput from "../fixtures/llm/invented-output.json";
import legacyOutput from "../fixtures/llm/legacy-output.json";
import validOutput from "../fixtures/llm/valid-output.json";

const catalog = EvidenceCatalogSchema.parse({ version: 1, entries: [
  { id: "ctx:0", type: "context", source: "incident.context", scope: "context", value: { resource: "example.test", analysisWindow: { start: "2026-09-20T00:00:00.000Z", end: "2026-09-20T00:31:00.000Z" } } },
  { id: "quality:0", type: "quality", source: "derived.quality", scope: "context", value: { dataSufficient: true, riskAssessable: true, catalogComplete: true, sampleCount: 10, nonNullUaSampleCount: 10 } },
  { id: "total:0", type: "total", source: "statistics.totalEvents", scope: "aggregate", value: { totalEvents: 100 } },
  { id: "agg:path:0", type: "aggregate_path", source: "incident.evidence.topPaths", scope: "aggregate", value: { value: "/index.php", count: 60 } },
  { id: "stat:path", type: "stat_path", source: "statistics.topPath", scope: "aggregate", value: { value: "/index.php", count: 60, ratio: 60 } },
  { id: "stat:allow", type: "stat_allow", source: "statistics.allowRatio", scope: "aggregate", value: { ratio: 80 } },
  { id: "finding:path_concentration", type: "finding", source: "findings", scope: "aggregate", value: { findingType: "path_concentration", level: "high", value: 60, threshold: 50, statId: "stat:path" } },
  { id: "finding:allow_ratio", type: "finding", source: "findings", scope: "aggregate", value: { findingType: "allow_ratio", level: "high", value: 80, threshold: 80, statId: "stat:allow" } },
], omitted: { aggregateItems: 0, samples: 0, oversizedValues: 0, dependentItems: 0 } });

afterEach(() => vi.unstubAllGlobals());
function completion(content: string, options: { finishReason?: string; refusal?: string | null; usage?: Record<string, unknown> } = {}): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: options.finishReason ?? "stop", message: { content, ...(options.refusal === undefined ? {} : { refusal: options.refusal }) } }], ...(options.usage === undefined ? {} : { usage: options.usage }) }));
}
function makeClient(fetchFn: typeof fetch): LLMClient { return new LLMClient({ baseUrl: "https://llm.example.test/v1/", model: "test-model", apiKey: "llm-test-secret", fetchFn, timeoutMs: 1000, maxOutputTokens: 2048 }); }
function requestBody(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) { const body = fetchFn.mock.calls[0]?.[1]?.body; if (typeof body !== "string") throw new Error("Expected string body"); return JSON.parse(body) as Record<string, unknown>; }

describe("LLMClient", () => {
  it("uses the wire Zod schema verbatim and maps valid output", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(validOutput)));
    await expect(makeClient(fetchFn).analyze(catalog)).resolves.toEqual({ schemaVersion: 2, risk: { level: "HIGH", evidenceIds: ["quality:0", "finding:allow_ratio", "stat:allow"] }, attack: { type: "Unknown", confidence: 0, evidenceIds: [] }, observations: [{ kind: "aggregate_concentration", dimension: "path", evidenceIds: ["stat:path", "finding:path_concentration", "total:0"] }], recommendations: [{ kind: "review_target", evidenceIds: ["agg:path:0"] }, { kind: "manual_dashboard", evidenceIds: ["ctx:0"] }] });
    expect(requestBody(fetchFn)).toMatchObject({ model: "test-model", max_completion_tokens: 2048, response_format: { type: "json_schema", json_schema: { name: "cloudflare_security_analysis", strict: true, schema: z.toJSONSchema(AIAnalysisWireSchema) } } });
  });

  it("sends only the bounded catalog and explicit support rules", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(validOutput)));
    await makeClient(fetchFn).analyze(catalog);
    const body = requestBody(fetchFn); const messages = body.messages as { role: string; content: string }[];
    const systemMessage = messages[0]; const userMessage = messages[1];
    if (systemMessage === undefined || userMessage === undefined) throw new Error("Expected system and user messages");
    expect(JSON.parse(userMessage.content)).toEqual(catalog);
    expect(systemMessage.content).toContain("Each risk, attack, observation, and recommendation must cite its own evidence_ids");
    expect(systemMessage.content).toContain("Do not infer relationships between aggregate entries");
    expect(systemMessage.content).toContain("no supported attack hypothesis");
    expect(systemMessage.content).toContain("HIGH or MEDIUM risk: quality + one highest-level risk finding + its stat");
    expect(systemMessage.content).toContain("LOW risk: quality + total, only when the risk finding set is empty");
    expect(systemMessage.content).toContain("CRITICAL risk is unsupported");
    expect(systemMessage.content).toContain("Bot attack only: stat_ua + high UA finding + stat_rate + high rate finding");
    expect(systemMessage.content).toContain("UA denominator >= 10 and confidence > 0 and <= 0.6");
    expect(systemMessage.content).toContain("All other non-Unknown attack types are unsupported");
    expect(systemMessage.content).toContain("aggregate_concentration: matching stat + matching medium/high finding + total");
    expect(systemMessage.content).toContain("action_ratio allow/block: matching stat + matching medium/high finding + total");
    expect(systemMessage.content).toContain("action_ratio challenge: stat_challenge + total");
    expect(systemMessage.content).toContain("request_rate: stat_rate + medium/high request_rate finding + context");
    expect(systemMessage.content).toContain("sample_ua_concentration: stat_ua + medium/high UA finding");
    expect(systemMessage.content).toContain("sample_observed: exactly one sample");
    expect(systemMessage.content).toContain("review_source: exactly one nonzero aggregate IP, country, or ASN");
    expect(systemMessage.content).toContain("review_target: exactly one nonzero aggregate path or host");
    expect(systemMessage.content).toContain("review_waf: stat_allow + medium/high allow finding + total");
    expect(systemMessage.content).toContain("verify_sample: exactly one sample or stat_ua");
    expect(systemMessage.content).toContain("manual_dashboard: context");
    expect(JSON.stringify(body)).not.toContain("llm-test-secret");
  });

  it("rejects an invalid catalog before requesting", async () => {
    const fetchFn = vi.fn<typeof fetch>(); const invalid = { ...catalog, extension: "secret-catalog-value" } as unknown as EvidenceCatalog;
    const error = await makeClient(fetchFn).analyze(invalid).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ai_catalog_invalid", validationStage: "catalog", validationReason: "invalid_catalog", validationPaths: ["root"], retryable: false });
    expect(fetchFn).not.toHaveBeenCalled(); expect(JSON.stringify(error)).not.toContain("secret-catalog-value");
  });

  it.each([
    ["legacy", legacyOutput], ["extra root", { ...validOutput, extension: true }], ["extra nested", { ...validOutput, risk: { ...validOutput.risk, rationale: "secret" } }],
    ["enum", { ...validOutput, risk: { ...validOutput.risk, level: "SEVERE" } }], ["confidence low", { ...validOutput, attack: { ...validOutput.attack, confidence: -0.01 } }], ["confidence high", { ...validOutput, attack: { ...validOutput.attack, confidence: 1.01 } }],
    ["ID characters", { ...validOutput, risk: { ...validOutput.risk, evidence_ids: ["BAD-ID"] } }], ["ID length", { ...validOutput, risk: { ...validOutput.risk, evidence_ids: ["a".repeat(65)] } }], ["references", { ...validOutput, risk: { ...validOutput.risk, evidence_ids: ["a", "b", "c", "d", "e"] } }],
    ["observations", { ...validOutput, observations: Array.from({ length: 7 }, () => validOutput.observations[0]) }], ["zero recommendations", { ...validOutput, recommendations: [] }], ["recommendations", { ...validOutput, recommendations: Array.from({ length: 4 }, () => validOutput.recommendations[0]) }],
  ])("locally rejects structurally invalid %s", async (_name, output) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(output)));
    await expect(makeClient(fetchFn).analyze(catalog)).rejects.toMatchObject({ code: "llm_output_schema_invalid", validationStage: "schema" }); expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not perform semantic reference validation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(inventedOutput)));
    await expect(makeClient(fetchFn).analyze(catalog)).resolves.toMatchObject({ risk: { evidenceIds: ["quality:0", "finding:not_real", "stat:allow"] } });
  });

  it("reports safe parsing and schema diagnostics without retries", async () => {
    const parsingFetch = vi.fn<typeof fetch>().mockResolvedValue(completion("secret-not-json"));
    const parsing = await makeClient(parsingFetch).analyze(catalog).catch((caught: unknown) => caught);
    expect(parsing).toMatchObject({ code: "llm_output_not_json", validationStage: "parsing", validationReason: "invalid_json" }); expect(JSON.stringify(parsing)).not.toContain("secret-not-json");
    const invalid = { ...validOutput, attack: { ...validOutput.attack, confidence: 2 }, recommendations: [{ kind: "secret-kind", evidence_ids: ["secret-id"] }] };
    const schemaFetch = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(invalid))); const schema = await makeClient(schemaFetch).analyze(catalog).catch((caught: unknown) => caught);
    expect(schema).toMatchObject({ code: "llm_output_schema_invalid", validationStage: "schema", validationReason: "limit_exceeded", issueCount: 3 });
    expect((schema as AppError).validationPaths).toEqual(expect.arrayContaining(["attack.confidence", "recommendations[].kind", "recommendations[].evidence_ids"]));
    expect(JSON.stringify(schema)).not.toContain("secret-kind"); expect(parsingFetch).toHaveBeenCalledOnce(); expect(schemaFetch).toHaveBeenCalledOnce();
  });

  it("prioritizes safe length and refusal diagnostics", async () => {
    const length = await makeClient(vi.fn<typeof fetch>().mockResolvedValue(completion("not-json", { finishReason: "length", usage: { completion_tokens: 2048, reasoning_tokens: 123 } }))).analyze(catalog).catch((caught: unknown) => caught);
    expect(length).toMatchObject({ code: "llm_output_truncated", finishReason: "length", completionTokens: 2048, reasoningTokens: 123, validationStage: "finish_reason" });
    const refusal = await makeClient(vi.fn<typeof fetch>().mockResolvedValue(completion("", { refusal: "sensitive refusal text", finishReason: "sensitive-finish" }))).analyze(catalog).catch((caught: unknown) => caught);
    expect(refusal).toMatchObject({ code: "llm_refused", finishReason: "unknown", refusalPresent: true, validationStage: "refusal" }); expect(JSON.stringify(refusal)).not.toContain("sensitive refusal text");
  });

  it.each([429, 503])("retries HTTP %i once", async (status) => { const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status })).mockResolvedValueOnce(completion(JSON.stringify(validOutput))); await expect(makeClient(fetchFn).analyze(catalog)).resolves.toMatchObject({ schemaVersion: 2 }); expect(fetchFn).toHaveBeenCalledTimes(2); });
  it.each([400, 401])("does not retry HTTP %i", async (status) => { const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("failed", { status })); await expect(makeClient(fetchFn).analyze(catalog)).rejects.toMatchObject({ httpStatus: status, retryable: false }); expect(fetchFn).toHaveBeenCalledOnce(); });

  it("does not retry HTTP 403 or timeout", async () => {
    const forbidden = vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 }));
    await expect(makeClient(forbidden).analyze(catalog)).rejects.toMatchObject({ httpStatus: 403, retryable: false });
    expect(forbidden).toHaveBeenCalledOnce();
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("sensitive timeout", "TimeoutError"));
    await expect(makeClient(timeout).analyze(catalog)).rejects.toMatchObject({ code: "llm_timeout", failureKind: "timeout", retryable: true });
    expect(timeout).toHaveBeenCalledOnce();
  });

  it("stops after one retry when transient HTTP errors are exhausted", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(makeClient(fetchFn).analyze(catalog)).rejects.toMatchObject({ httpStatus: 503, retryable: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not make a repair request after a transient retry returns invalid output", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("busy", { status: 429 })).mockResolvedValueOnce(completion("not-json"));
    await expect(makeClient(fetchFn).analyze(catalog)).rejects.toMatchObject({ code: "llm_output_not_json", retryable: false });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retains protocol and network classifications", async () => { for (const testCase of [{ fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json")), expected: { failureKind: "invalid_response", retryable: false } }, { fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")), expected: { failureKind: "network", retryable: true } }]) { const error = await makeClient(testCase.fetchFn).analyze(catalog).catch((caught: unknown) => caught); expect(error).toBeInstanceOf(AppError); expect(error).toMatchObject({ externalService: "llm", ...testCase.expected }); } });

  it("calls the default Workers fetch without an invalid receiver", async () => {
    const runtimeFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== undefined) throw new TypeError("Illegal invocation: incorrect receiver");
      return Promise.resolve(completion(JSON.stringify(validOutput)));
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const client = new LLMClient({ baseUrl: "https://llm.example.test/v1", model: "test-model", apiKey: "secret", timeoutMs: 1000, maxOutputTokens: 2048 });
    await expect(client.analyze(catalog)).resolves.toMatchObject({ schemaVersion: 2 });
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });
});
