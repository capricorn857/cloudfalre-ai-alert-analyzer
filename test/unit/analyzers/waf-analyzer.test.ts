import { describe, expect, it, vi } from "vitest";

import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import { AppError } from "../../../src/observability/errors";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";

describe("analyzeWafAlert", () => {
  it("collects one fixed snapshot and returns deterministic analysis", async () => {
    const collectSnapshot = vi.fn().mockResolvedValue(snapshot);

    const result = await analyzeWafAlert(queueMessage, { collectSnapshot }, rulesConfig);

    expect(result.status).toBe("success");
    expect(collectSnapshot).toHaveBeenCalledOnce();
    expect(collectSnapshot).toHaveBeenCalledWith({
      zoneTag: queueMessage.alert.zoneTag,
      analysisWindow: queueMessage.analysisWindow,
      sampleLimit: 50,
    });
    if (result.status === "success") expect(result.statistics.totalEvents).toBe(400);
  });

  it("returns empty without collecting again", async () => {
    const collectSnapshot = vi.fn().mockResolvedValue({
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
    });

    const result = await analyzeWafAlert(queueMessage, { collectSnapshot }, rulesConfig);

    expect(result.status).toBe("empty");
    expect(collectSnapshot).toHaveBeenCalledOnce();
  });

  it("returns collection_failed after the client exhausts retries", async () => {
    const collectSnapshot = vi
      .fn()
      .mockRejectedValue(
        new AppError("cloudflare_http_retryable", "failed", true, 503, {
          externalService: "cloudflare",
          failureKind: "http",
          durationMs: 48,
          httpStatus: 503,
        }),
      );

    const result = await analyzeWafAlert(queueMessage, { collectSnapshot }, rulesConfig);

    expect(result).toMatchObject({
      status: "collection_failed",
      errorCode: "cloudflare_http_retryable",
      failure: {
        externalService: "cloudflare",
        errorCode: "cloudflare_http_retryable",
        failureKind: "http",
        retryable: true,
        durationMs: 48,
        httpStatus: 503,
      },
      message: queueMessage,
    });
    expect(collectSnapshot).toHaveBeenCalledOnce();
  });
});
