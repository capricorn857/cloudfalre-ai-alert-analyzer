import { describe, expect, it, vi } from "vitest";

import { runAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";
import { AppError } from "../../../src/observability/errors";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";

const analysis: AIAnalysis = {
  riskLevel: "HIGH",
  attackType: "Brute Force",
  confidence: 0.82,
  summary: "Traffic is concentrated on /api/login.",
  evidence: ["/api/login = 45%"],
  recommendations: ["Review rate limiting for /api/login."],
};

describe("runAIAnalysis", () => {
  it("returns an available result for validated model output", async () => {
    const snapshotResult = await analyzeWafAlert(
      queueMessage,
      { collectSnapshot: () => Promise.resolve(snapshot) },
      rulesConfig,
    );
    const analyze = vi.fn().mockResolvedValue(analysis);

    await expect(runAIAnalysis(snapshotResult, { analyze })).resolves.toEqual({
      status: "available",
      analysis,
    });
  });

  it("converts every LLM failure to a non-throwing degradation", async () => {
    const snapshotResult = await analyzeWafAlert(
      queueMessage,
      { collectSnapshot: () => Promise.resolve(snapshot) },
      rulesConfig,
    );
    const analyze = vi.fn().mockRejectedValue(
      new AppError("llm_timeout", "model timed out", true, undefined, {
        externalService: "llm",
        failureKind: "timeout",
        durationMs: 250,
      }),
    );

    await expect(runAIAnalysis(snapshotResult, { analyze })).resolves.toMatchObject({
      status: "unavailable",
      reason: "AI analysis unavailable",
      failure: {
        externalService: "llm",
        errorCode: "llm_timeout",
        failureKind: "timeout",
        retryable: true,
        durationMs: 250,
      },
    });
  });

  it("does not call the model when Cloudflare collection failed or data is empty", async () => {
    const analyze = vi.fn().mockResolvedValue(analysis);
    await expect(
      runAIAnalysis(
        {
          status: "collection_failed",
          message: queueMessage,
          errorCode: "cloudflare_failed",
          failure: {
            externalService: "cloudflare",
            errorCode: "cloudflare_failed",
            failureKind: "unknown",
            retryable: false,
            durationMs: 0,
          },
        },
        { analyze },
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    const emptyResult = await analyzeWafAlert(
      queueMessage,
      {
        collectSnapshot: () =>
          Promise.resolve({
            ...snapshot,
            totalEvents: 0,
            topIps: [],
            topPaths: [],
            topHosts: [],
            topCountries: [],
            topAsns: [],
            actions: [],
            sources: [],
            samples: [],
          }),
      },
      rulesConfig,
    );
    await expect(runAIAnalysis(emptyResult, { analyze })).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(analyze).not.toHaveBeenCalled();
  });
});
