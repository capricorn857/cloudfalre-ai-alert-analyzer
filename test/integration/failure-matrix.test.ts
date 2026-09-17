import { describe, expect, it, vi } from "vitest";

import { processAlert } from "../../src/pipeline/process-alert";
import { AppError } from "../../src/observability/errors";
import { queueMessage, rulesConfig, snapshot } from "../fixtures/domain";

function baseDependencies() {
  return {
    cloudflare: { collectSnapshot: vi.fn().mockResolvedValue(snapshot) },
    ai: {
      analyze: vi.fn().mockResolvedValue({
        riskLevel: "HIGH",
        attackType: "Brute Force",
        confidence: 0.8,
        summary: "Traffic targets /api/login.",
        evidence: ["/api/login = 45%"],
        recommendations: ["Review /api/login rate limiting."],
      }),
    },
    notification: { send: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rulesConfig,
    formatterOptions: { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 },
  };
}

describe("external dependency failure matrix", () => {
  it("does not call AI when Cloudflare collection is exhausted, but still notifies", async () => {
    const dependencies = baseDependencies();
    dependencies.cloudflare.collectSnapshot.mockRejectedValue(
      new AppError("cloudflare_http_retryable", "failed", true, 503, {
        externalService: "cloudflare",
        failureKind: "http",
        durationMs: 31,
        httpStatus: 503,
      }),
    );

    await expect(processAlert(queueMessage, dependencies)).resolves.toMatchObject({
      status: "sent",
      snapshotStatus: "collection_failed",
      aiStatus: "unavailable",
    });
    expect(dependencies.ai.analyze).not.toHaveBeenCalled();
    expect(dependencies.notification.send).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "external_api_failed",
      expect.objectContaining({
        external_service: "cloudflare",
        error_code: "cloudflare_http_retryable",
        failure_kind: "http",
        retryable: true,
        duration_ms: 31,
        http_status: 503,
      }),
    );
  });

  it("degrades LLM failure and still sends exactly once", async () => {
    const dependencies = baseDependencies();
    dependencies.ai.analyze.mockRejectedValue(
      new AppError("llm_timeout", "timeout", true, undefined, {
        externalService: "llm",
        failureKind: "timeout",
        durationMs: 42,
      }),
    );

    await expect(processAlert(queueMessage, dependencies)).resolves.toMatchObject({
      status: "sent",
      aiStatus: "unavailable",
    });
    expect(dependencies.cloudflare.collectSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.notification.send).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "external_api_failed",
      expect.objectContaining({
        external_service: "llm",
        error_code: "llm_timeout",
        failure_kind: "timeout",
        retryable: true,
        duration_ms: 42,
      }),
    );
  });

  it("records final notification failure without repeating collection or AI", async () => {
    const dependencies = baseDependencies();
    dependencies.notification.send.mockRejectedValue(
      new AppError("wecom_http_retryable", "failed", true, 500, {
        externalService: "wecom",
        failureKind: "http",
        durationMs: 53,
        httpStatus: 500,
        responseCategory: "http_error",
      }),
    );

    await expect(processAlert(queueMessage, dependencies)).resolves.toMatchObject({
      status: "notification_failed",
    });
    expect(dependencies.cloudflare.collectSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.ai.analyze).toHaveBeenCalledOnce();
    expect(dependencies.notification.send).toHaveBeenCalledOnce();
    expect(dependencies.logger.error).toHaveBeenCalledWith(
      "notification_failed",
      expect.objectContaining({
        external_service: "wecom",
        error_code: "wecom_http_retryable",
        failure_kind: "http",
        retryable: true,
        duration_ms: 53,
        http_status: 500,
        response_category: "http_error",
      }),
    );
  });
});
