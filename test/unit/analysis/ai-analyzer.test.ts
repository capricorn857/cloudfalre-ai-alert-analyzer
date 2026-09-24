import { describe, expect, it, vi } from "vitest";

import { runAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";
import { AppError } from "../../../src/observability/errors";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { structuredAnalysis } from "../../fixtures/structured-ai";

const analysis: AIAnalysis = structuredAnalysis();

describe("runAIAnalysis", () => {
  it("returns an available result for validated model output", async () => {
    const snapshotResult = await analyzeWafAlert(
      queueMessage,
      { collectSnapshot: () => Promise.resolve(snapshot) },
      rulesConfig,
    );
    const analyze = vi.fn().mockResolvedValue(analysis);

    await expect(runAIAnalysis(snapshotResult, { analyze })).resolves.toMatchObject({
      status: "available",
      analysis: { analysis },
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

  it("keeps the safe Evidence failure reason during rules degradation", async () => {
    const snapshotResult = await analyzeWafAlert(
      queueMessage,
      { collectSnapshot: () => Promise.resolve(snapshot) },
      rulesConfig,
    );
    const analyze = vi.fn().mockRejectedValue(
      new AppError("ai_reference_invalid", "ai_reference_invalid", false, undefined, {
        externalService: "llm",
        failureKind: "invalid_response",
        durationMs: 19,
        validationStage: "reference",
        validationReason: "reference_not_found",
      }),
    );

    await expect(runAIAnalysis(snapshotResult, { analyze })).resolves.toMatchObject({
      status: "unavailable",
      failure: {
        errorCode: "ai_reference_invalid",
        validationStage: "reference",
        validationReason: "reference_not_found",
        retryable: false,
      },
    });
  });

  it("does not trust a replacement client's structurally valid unsupported claim", async () => {
    const snapshotResult = await analyzeWafAlert(queueMessage, { collectSnapshot: () => Promise.resolve(snapshot) }, rulesConfig);
    const unsupported = structuredAnalysis();
    unsupported.attack = { type: "Brute Force", confidence: 0.8, evidenceIds: ["stat:path"] };
    await expect(runAIAnalysis(snapshotResult, { analyze: () => Promise.resolve(unsupported) })).resolves.toMatchObject({
      status: "unavailable", failure: { errorCode: "ai_claim_unsupported", retryable: false },
    });
  });

  it("isolates invalid catalogs without calling the client or assigning Provider blame", async () => {
    const snapshotResult = await analyzeWafAlert(queueMessage, { collectSnapshot: () => Promise.resolve(snapshot) }, rulesConfig);
    if (snapshotResult.status === "collection_failed") throw new Error("fixture");
    snapshotResult.statistics.totalEvents += 1;
    const analyze = vi.fn().mockResolvedValue(analysis);
    const result = await runAIAnalysis(snapshotResult, { analyze });
    expect(result).toMatchObject({ status: "unavailable", failure: { failureSource: "catalog", errorCode: "ai_catalog_invalid" } });
    expect(analyze).not.toHaveBeenCalled();
    if (result.status === "unavailable") expect(result.failure).not.toHaveProperty("externalService");
  });

  it("does not let a client alter the catalog used for support validation", async () => {
    const snapshotResult = await analyzeWafAlert(queueMessage, { collectSnapshot: () => Promise.resolve(snapshot) }, rulesConfig);
    const result = await runAIAnalysis(snapshotResult, { analyze: (catalog) => {
      catalog.entries = catalog.entries.filter((entry) => entry.type !== "finding");
      const output = structuredAnalysis();
      output.risk = { level: "LOW", evidenceIds: ["quality:0", "total:0"] };
      output.observations = [];
      return Promise.resolve(output);
    } });
    expect(result).toMatchObject({ status: "unavailable", failure: { errorCode: "ai_claim_unsupported" } });
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
