import { afterEach, describe, expect, it, vi } from "vitest";

import { calculateStatistics } from "../../../src/analysis/statistics";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { evaluateRules } from "../../../src/analysis/rules";
import { buildEvidenceCatalog } from "../../../src/analysis/evidence-catalog";
import { createProcessAlertDependencies } from "../../../src/config/dependencies";
import { parseEnv } from "../../../src/config/env";
import { businessConfig, validEnv } from "../../fixtures/config";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import aggregateSuccess from "../../fixtures/graphql/aggregate-success.json";
import samplesSuccess from "../../fixtures/graphql/samples-success.json";
import validOutput from "../../fixtures/llm/valid-output.json";

const incident = normalizeIncident(queueMessage, snapshot);
const statistics = calculateStatistics(incident);
const findings = evaluateRules(statistics, rulesConfig);

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("createProcessAlertDependencies", () => {
  it("isolates the LLM timeout from GraphQL and WeCom timeouts", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(aggregateSuccess))
      .mockResolvedValueOnce(jsonResponse(samplesSuccess))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(validOutput) } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const config = parseEnv({
      ...validEnv,
      BUSINESS_CONFIG: {
        ...businessConfig,
        requestTimeoutMs: 10_000,
        llmTimeoutMs: 30_000,
        llmMaxOutputTokens: 4096,
      },
    });
    const dependencies = createProcessAlertDependencies(config);

    await dependencies.cloudflare.collectSnapshot({
      zoneTag: queueMessage.alert.zoneTag,
      analysisWindow: queueMessage.analysisWindow,
      sampleLimit: queueMessage.configSnapshot.sampleLimit,
    });
    await dependencies.ai.analyze(buildEvidenceCatalog({ incident, statistics, findings }));
    await dependencies.notification.send("test message");

    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      10_000,
      10_000,
      30_000,
      10_000,
    ]);
    const rawLlmBody = fetchMock.mock.calls[2]?.[1]?.body;
    if (typeof rawLlmBody !== "string") throw new Error("Expected serialized LLM request");
    const llmBody = JSON.parse(rawLlmBody) as Record<string, unknown>;
    expect(llmBody.max_completion_tokens).toBe(4096);
  });

  it("keeps the LLM request pending until its independent timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("The operation timed out", "TimeoutError"));
      }, milliseconds);
      return controller.signal;
    });
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === null || signal === undefined) {
          reject(new Error("Expected an abort signal"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Request aborted"),
            );
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = parseEnv({
      ...validEnv,
      BUSINESS_CONFIG: {
        ...businessConfig,
        requestTimeoutMs: 10_000,
        llmTimeoutMs: 30_000,
      },
    });
    const dependencies = createProcessAlertDependencies(config);
    let settled = false;
    const result = dependencies.ai
      .analyze(buildEvidenceCatalog({ incident, statistics, findings }))
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(result).resolves.toMatchObject({
      status: "rejected",
      error: { code: "llm_timeout", failureKind: "timeout" },
    });
  });
});
