import { afterEach, describe, expect, it, vi } from "vitest";

import { LLMClient } from "../../src/clients/llm";
import { AppError } from "../../src/observability/errors";
import { calculateStatistics } from "../../src/analysis/statistics";
import { normalizeIncident } from "../../src/analysis/normalizer";
import { evaluateRules } from "../../src/analysis/rules";
import { queueMessage, rulesConfig, snapshot } from "../fixtures/domain";
import inventedOutput from "../fixtures/llm/invented-output.json";
import validOutput from "../fixtures/llm/valid-output.json";

const incident = normalizeIncident(queueMessage, snapshot);
const statistics = calculateStatistics(incident);
const findings = evaluateRules(statistics, rulesConfig);
const input = { incident, statistics, findings };

afterEach(() => {
  vi.unstubAllGlobals();
});

function completion(
  content: string,
  options: { finishReason?: string; refusal?: string | null; usage?: Record<string, unknown> } = {},
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: options.finishReason ?? "stop",
          message: { content, ...(options.refusal === undefined ? {} : { refusal: options.refusal }) },
        },
      ],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function requestBody(fetchFn: ReturnType<typeof vi.fn<typeof fetch>>) {
  const body = fetchFn.mock.calls[0]?.[1]?.body;
  if (typeof body !== "string") throw new Error("Expected string request body");
  return JSON.parse(body) as Record<string, unknown>;
}

describe("LLMClient", () => {
  it("calls the default Workers fetch without an invalid receiver", async () => {
    const runtimeFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation: function called with incorrect this reference");
      }
      return Promise.resolve(completion(JSON.stringify(validOutput)));
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).resolves.toMatchObject({
      riskLevel: "HIGH",
      attackType: "Brute Force",
    });
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });

  it("sends only bounded domain input and returns validated AIAnalysis", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(validOutput)));
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).resolves.toMatchObject({
      riskLevel: "HIGH",
      attackType: "Brute Force",
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://llm.example.test/v1/chat/completions");
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      model: "test-model",
      max_completion_tokens: 2048,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "cloudflare_security_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: [
              "risk_level",
              "attack_type",
              "confidence",
              "summary",
              "evidence",
              "recommendations",
            ],
            properties: {
              risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
              attack_type: {
                type: "string",
                enum: [
                  "Scanning",
                  "Brute Force",
                  "Credential Stuffing",
                  "API Abuse",
                  "Bot",
                  "Vulnerability Scanning",
                  "Unknown",
                ],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              summary: { type: "string", minLength: 1, maxLength: 1000 },
              evidence: {
                type: "array",
                maxItems: 10,
                items: { type: "string", minLength: 1, maxLength: 500 },
              },
              recommendations: {
                type: "array",
                maxItems: 3,
                items: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    });
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]?.content).toContain("recommendations must contain no more than 3 items");
    expect(messages[0]?.content).toContain("confidence must be between 0 and 1");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("raw_payload");
    expect(serialized).not.toContain("llm-test-secret");
  });

  it.each([
    ["llm_output_not_json", completion("not-json")],
    ["llm_output_not_json", completion(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``)],
    ["llm_output_schema_invalid", completion(JSON.stringify({ risk_level: "HIGH" }))],
    ["ai_evidence_invalid", completion(JSON.stringify(inventedOutput))],
  ] as const)("classifies model output failure as %s", async (expectedCode, response) => {
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1/",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response),
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).rejects.toMatchObject({ code: expectedCode });
  });

  it("classifies a length finish reason before parsing content", async () => {
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        completion(JSON.stringify(validOutput), {
          finishReason: "length",
          usage: { completion_tokens: 2048, reasoning_tokens: 123 },
        }),
      ),
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).rejects.toMatchObject({
      code: "llm_output_truncated",
      finishReason: "length",
      completionTokens: 2048,
      reasoningTokens: 123,
      validationStage: "finish_reason",
    });
  });

  it("classifies a provider refusal without retaining refusal text", async () => {
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(
        completion("", { refusal: "sensitive refusal text" }),
      ),
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    const error = await client.analyze(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "llm_refused",
      refusalPresent: true,
      validationStage: "refusal",
    });
    expect(JSON.stringify(error)).not.toContain("sensitive refusal text");
  });

  it("records safe schema issue paths without field values", async () => {
    const invalid = {
      ...(validOutput as Record<string, unknown>),
      risk_level: "NOT_A_LEVEL",
      confidence: 2,
      recommendations: ["one", "two", "three", "four"],
    };
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(invalid))),
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    const error = await client.analyze(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "llm_output_schema_invalid",
      validationStage: "schema",
    });
    const paths = (error as AppError).schemaIssuePaths ?? [];
    expect(paths).toContain("risk_level");
    expect(paths).toContain("confidence");
    expect(paths).toContain("recommendations");
    expect(JSON.stringify(error)).not.toContain("NOT_A_LEVEL");
  });

  it.each([
    [
      "recommendation item too long",
      { ...(validOutput as Record<string, unknown>), recommendations: ["x".repeat(501)] },
    ],
    ["summary too long", { ...(validOutput as Record<string, unknown>), summary: "x".repeat(1001) }],
    [
      "too many evidence items",
      { ...(validOutput as Record<string, unknown>), evidence: Array.from({ length: 11 }, () => "fact") },
    ],
  ])("rejects %s using the local Schema", async (_caseName, output) => {
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(completion(JSON.stringify(output))),
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).rejects.toMatchObject({
      code: "llm_output_schema_invalid",
      validationStage: "schema",
    });
  });

  it("attaches stable fields to HTTP and network failures", async () => {
    const cases = [
      {
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(new Response("failed", { status: 429 })),
        expected: { failureKind: "http", httpStatus: 429, retryable: true },
      },
      {
        fetchFn: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
        expected: { failureKind: "network", retryable: true },
      },
    ];

    for (const testCase of cases) {
      const client = new LLMClient({
        baseUrl: "https://llm.example.test/v1",
        model: "test-model",
        apiKey: "llm-test-secret",
        fetchFn: testCase.fetchFn,
        timeoutMs: 1000,
        maxOutputTokens: 2048,
      });

      const error = await client.analyze(input).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ externalService: "llm", ...testCase.expected });
      expect((error as AppError).durationMs).toEqual(expect.any(Number));
    }
  });

  it.each([429, 503])("retries HTTP %i at most once and returns the successful result", async (status) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status }))
      .mockResolvedValueOnce(completion(JSON.stringify(validOutput)));
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).resolves.toMatchObject({ riskLevel: "HIGH" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401])("does not retry HTTP %i", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("failed", { status }));
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).rejects.toMatchObject({ httpStatus: status });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not retry output validation failures", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(completion("not-json"));
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn,
      timeoutMs: 1000,
      maxOutputTokens: 2048,
    });

    await expect(client.analyze(input)).rejects.toMatchObject({ code: "llm_output_not_json" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("classifies invalid protocol and model output without preserving raw content", async () => {
    for (const response of [
      new Response("not-json", { status: 200 }),
      completion("sensitive-invalid-output"),
    ]) {
      const client = new LLMClient({
        baseUrl: "https://llm.example.test/v1",
        model: "test-model",
        apiKey: "llm-test-secret",
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response),
        timeoutMs: 1000,
        maxOutputTokens: 2048,
      });

      const error = await client.analyze(input).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        externalService: "llm",
        failureKind: "invalid_response",
        retryable: false,
      });
      expect(JSON.stringify(error)).not.toContain("sensitive-invalid-output");
    }
  });
});
