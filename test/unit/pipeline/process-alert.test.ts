import { describe, expect, it, vi } from "vitest";

import { processAlert } from "../../../src/pipeline/process-alert";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";
import { AppError } from "../../../src/observability/errors";

const analysis: AIAnalysis = {
  riskLevel: "HIGH",
  attackType: "Brute Force",
  confidence: 0.8,
  summary: "Traffic is concentrated on /api/login.",
  evidence: ["/api/login = 45%"],
  recommendations: ["Review rate limiting for /api/login."],
};

function dependencies(events: string[]) {
  return {
    cloudflare: {
      collectSnapshot: () => {
        events.push("cloudflare");
        return Promise.resolve(snapshot);
      },
    },
    ai: {
      analyze: () => {
        events.push("ai");
        return Promise.resolve(analysis);
      },
    },
    notification: {
      send: (message: string) => {
        events.push("notification");
        expect(message).toContain("incident_id: correlation-123");
        return Promise.resolve();
      },
    },
    logger: {
      info: () => {
        events.push("log");
      },
      warn: vi.fn(),
      error: vi.fn(),
    },
    rulesConfig,
    formatterOptions: { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 },
  };
}

describe("processAlert", () => {
  it("orchestrates collection, AI, formatting, and notification in order", async () => {
    const events: string[] = [];

    await expect(processAlert(queueMessage, dependencies(events))).resolves.toMatchObject({
      status: "sent",
      snapshotStatus: "success",
      aiStatus: "available",
    });
    expect(events).toEqual(["cloudflare", "ai", "notification", "log"]);
  });

  it("sends a fallback notification when AI fails", async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.ai.analyze = () => Promise.reject(new Error("model failed"));

    await expect(processAlert(queueMessage, deps)).resolves.toMatchObject({
      status: "sent",
      aiStatus: "unavailable",
    });
    expect(events).toEqual(["cloudflare", "notification", "log"]);
  });

  it("records notification failure without throwing to Queue and isolates logging failure after send", async () => {
    const sendFailure = dependencies([]);
    sendFailure.notification.send = () =>
      Promise.reject(
        new AppError("wecom_http_retryable", "send failed", true, 503, {
          externalService: "wecom",
          failureKind: "http",
          durationMs: 75,
          httpStatus: 503,
          responseCategory: "http_error",
        }),
      );
    await expect(processAlert(queueMessage, sendFailure)).resolves.toMatchObject({
      status: "notification_failed",
      snapshotStatus: "success",
      aiStatus: "available",
    });
    expect(sendFailure.logger.error).toHaveBeenCalledWith(
      "notification_failed",
      expect.objectContaining({
        external_service: "wecom",
        error_code: "wecom_http_retryable",
        failure_kind: "http",
        retryable: true,
        duration_ms: 75,
        http_status: 503,
        response_category: "http_error",
      }),
    );

    const events: string[] = [];
    const postSendFailure = dependencies(events);
    postSendFailure.logger.info = () => {
      throw new Error("logger failed");
    };
    await expect(processAlert(queueMessage, postSendFailure)).resolves.toMatchObject({ status: "sent" });
    expect(events.filter((event) => event === "notification")).toHaveLength(1);
  });

  it("preserves the snapshot error code when collection and notification both fail", async () => {
    const deps = dependencies([]);
    const collectSnapshot = vi.fn().mockRejectedValue(
      new AppError("cloudflare_graphql_errors", "collection failed", false, undefined, {
        externalService: "cloudflare",
        failureKind: "service_error",
        durationMs: 44,
      }),
    );
    const analyze = vi.fn();
    const send = vi.fn().mockRejectedValue(
      new AppError("wecom_network", "send failed", true, undefined, {
        externalService: "wecom",
        failureKind: "network",
        durationMs: 81,
        responseCategory: "transport_error",
      }),
    );
    deps.cloudflare.collectSnapshot = collectSnapshot;
    deps.ai.analyze = analyze;
    deps.notification.send = send;

    await expect(processAlert(queueMessage, deps)).resolves.toMatchObject({
      status: "notification_failed",
      snapshotStatus: "collection_failed",
      aiStatus: "unavailable",
    });

    expect(deps.logger.error).toHaveBeenCalledWith(
      "notification_failed",
      expect.objectContaining({
        error_code: "wecom_network",
        snapshot_error_code: "cloudflare_graphql_errors",
        failure_kind: "network",
      }),
    );
    expect(collectSnapshot).toHaveBeenCalledOnce();
    expect(analyze).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});
