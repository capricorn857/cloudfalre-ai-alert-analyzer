import { describe, expect, it, vi } from "vitest";

import { processAlert } from "../../src/pipeline/process-alert";
import { AppError } from "../../src/observability/errors";
import { queueMessage, rulesConfig, snapshot } from "../fixtures/domain";
import { LLMClient } from "../../src/clients/llm";
import { calculateStatistics } from "../../src/analysis/statistics";
import validOutput from "../fixtures/llm/valid-output.json";
import { structuredAnalysis } from "../fixtures/structured-ai";

vi.mock("../../src/analysis/statistics", { spy: true });

function baseDependencies() {
  return {
    cloudflare: { collectSnapshot: vi.fn().mockResolvedValue(snapshot) },
    ai: {
      analyze: vi.fn().mockResolvedValue(structuredAnalysis()),
    },
    notification: { send: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    rulesConfig,
    formatterOptions: { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 },
  };
}

describe("external dependency failure matrix", () => {
  it("uses one LLM attempt, one snapshot and one statistics calculation for Evidence fallback", async () => {
    vi.mocked(calculateStatistics).mockClear();
    const dependencies = baseDependencies();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        ...validOutput, attack: { type: "Unknown", confidence: 0, evidence_ids: ["missing:0"] },
      }) } }],
      usage: { completion_tokens: 77, reasoning_tokens: 12 },
    })));
    const ai = new LLMClient({ baseUrl: "https://llm.example.test/v1", model: "test", apiKey: "test-only", fetchFn, timeoutMs: 1000, maxOutputTokens: 2048 });
    await expect(processAlert(queueMessage, { ...dependencies, ai })).resolves.toMatchObject({ status: "sent", aiStatus: "unavailable" });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(dependencies.cloudflare.collectSnapshot).toHaveBeenCalledOnce();
    expect(calculateStatistics).toHaveBeenCalledOnce();
    expect(dependencies.notification.send).toHaveBeenCalledOnce();
    const notification = String(dependencies.notification.send.mock.calls[0]?.[0]);
    expect(notification).toContain("AI 分析暂不可用");
    expect(notification).not.toContain("Evidence sentinel");
    expect(dependencies.logger.warn).toHaveBeenCalledWith("external_api_failed", expect.objectContaining({
      error_code: "ai_reference_invalid", validation_reason: "reference_not_found", retryable: false,
      finish_reason: "stop", completion_tokens: 77, reasoning_tokens: 12,
    }));
  });
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

  it("keeps the fallback notification single-shot after a classified LLM output failure", async () => {
    const dependencies = baseDependencies();
    dependencies.ai.analyze.mockRejectedValue(
      new AppError("llm_output_schema_invalid", "llm_output_schema_invalid", false, undefined, {
        externalService: "llm",
        failureKind: "invalid_response",
        durationMs: 17,
        validationStage: "schema",
        validationPaths: ["risk.level", "attack.confidence"],
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
        error_code: "llm_output_schema_invalid",
        validation_stage: "schema",
        validation_paths: ["risk.level", "attack.confidence"],
      }),
    );
  });

  it("keeps Evidence failures non-retryable and logs only the safe reason", async () => {
    const dependencies = baseDependencies();
    dependencies.ai.analyze.mockRejectedValue(
      new AppError("ai_claim_unsupported", "ai_claim_unsupported", false, undefined, {
        externalService: "llm",
        failureKind: "invalid_response",
        durationMs: 17,
        validationStage: "support",
        validationReason: "unsupported_claim_type",
      }),
    );

    await expect(processAlert(queueMessage, dependencies)).resolves.toMatchObject({
      status: "sent",
      aiStatus: "unavailable",
    });
    expect(dependencies.cloudflare.collectSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.ai.analyze).toHaveBeenCalledOnce();
    expect(dependencies.notification.send).toHaveBeenCalledOnce();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      "external_api_failed",
      expect.objectContaining({
        error_code: "ai_claim_unsupported",
        validation_stage: "support",
        validation_reason: "unsupported_claim_type",
        retryable: false,
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
