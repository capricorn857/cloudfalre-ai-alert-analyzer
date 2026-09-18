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

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { "content-type": "application/json" },
  });
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
      maxOutputTokens: 800,
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
      maxOutputTokens: 800,
    });

    await expect(client.analyze(input)).resolves.toMatchObject({
      riskLevel: "HIGH",
      attackType: "Brute Force",
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe("https://llm.example.test/v1/chat/completions");
    const body = requestBody(fetchFn);
    expect(body).toMatchObject({
      model: "test-model",
      max_completion_tokens: 800,
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
              confidence: { type: "number" },
              summary: { type: "string" },
              evidence: {
                type: "array",
                items: { type: "string" },
              },
              recommendations: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("raw_payload");
    expect(serialized).not.toContain("llm-test-secret");
  });

  it.each([
    completion("not-json"),
    completion(JSON.stringify({ risk_level: "HIGH" })),
    completion(JSON.stringify(inventedOutput)),
    new Response("failed", { status: 500 }),
  ])("rejects invalid, unsupported, or failed model responses", async (response) => {
    const client = new LLMClient({
      baseUrl: "https://llm.example.test/v1/",
      model: "test-model",
      apiKey: "llm-test-secret",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response),
      timeoutMs: 1000,
      maxOutputTokens: 800,
    });

    await expect(client.analyze(input)).rejects.toBeDefined();
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
        maxOutputTokens: 800,
      });

      const error = await client.analyze(input).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ externalService: "llm", ...testCase.expected });
      expect((error as AppError).durationMs).toEqual(expect.any(Number));
    }
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
        maxOutputTokens: 800,
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
