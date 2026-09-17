import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../../src/observability/logger";

describe("structured logger", () => {
  it("writes one JSON line with correlation fields", () => {
    const sink = vi.fn<(line: string) => void>();
    const logger = createLogger({ sink });

    logger.info("notification_sent", {
      incident_id: "incident-1",
      correlation_id: "correlation-1",
      analysis_window: {
        start: "2026-09-14T08:48:46.000Z",
        end: "2026-09-14T09:20:00.000Z",
      },
      processing_duration_ms: 123,
    });

    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.parse(sink.mock.calls[0]?.[0] ?? "{}")).toMatchObject({
      level: "info",
      event: "notification_sent",
      incident_id: "incident-1",
    });
  });

  it("redacts sensitive keys, known secret values, URLs, and oversized text", () => {
    const sink = vi.fn<(line: string) => void>();
    const secrets = ["cf-secret-sentinel", "llm-secret-sentinel", "wecom-secret-sentinel"];
    const logger = createLogger({ sink, secrets, maxStringLength: 40 });

    logger.error("external_failure", {
      authorization: "Bearer cf-secret-sentinel",
      apiKey: "llm-secret-sentinel",
      webhookUrl: "https://qyapi.weixin.qq.com/send?key=wecom-secret-sentinel",
      error: `request failed with cf-secret-sentinel ${"x".repeat(100)}`,
    });

    const line = sink.mock.calls[0]?.[0] ?? "";
    for (const secret of secrets) expect(line).not.toContain(secret);
    expect(line).toContain("[REDACTED]");
    expect(line.length).toBeLessThan(500);
  });

  it("sanitizes Error names and sensitive URL query values before serialization", () => {
    const sink = vi.fn<(line: string) => void>();
    const nameSentinel = "ERROR_NAME_SENTINEL";
    const logger = createLogger({ sink, secrets: [nameSentinel], maxStringLength: 80 });
    const error = new TypeError(
      "request failed at https://example.invalid/webhook?key=QUERY_SENTINEL&mode=test",
      { cause: { token: "CAUSE_SENTINEL" } },
    );
    error.name = `TypeError-${nameSentinel}`;

    logger.error("external_failure", {
      error,
      diagnostic_message:
        "https://example.invalid/api?api_key=URL_API_KEY_SENTINEL key=KEY_SENTINEL " +
        "x".repeat(200),
    });

    const line = sink.mock.calls[0]?.[0] ?? "";
    for (const sentinel of [
      nameSentinel,
      "QUERY_SENTINEL",
      "CAUSE_SENTINEL",
      "URL_API_KEY_SENTINEL",
      "KEY_SENTINEL",
    ]) {
      expect(line).not.toContain(sentinel);
    }
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("[TRUNCATED]");
  });
});
