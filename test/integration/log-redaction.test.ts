import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/observability/logger";
import { AppError } from "../../src/observability/errors";

describe("log redaction integration", () => {
  it("removes every configured secret from nested external error data", () => {
    const sink = vi.fn<(line: string) => void>();
    const cloudflareSecret = "CF_SENTINEL_DO_NOT_LOG";
    const llmSecret = "LLM_SENTINEL_DO_NOT_LOG";
    const wecomSecret = "WECOM_SENTINEL_DO_NOT_LOG";
    const secrets = [cloudflareSecret, llmSecret, wecomSecret];
    const logger = createLogger({ sink, secrets, maxStringLength: 100 });

    logger.error("dependency_failed", {
      incident_id: "incident-test",
      headers: { Authorization: `Bearer ${cloudflareSecret}` },
      nested: {
        api_key: llmSecret,
        url: `https://example.test/webhook?key=${wecomSecret}`,
        diagnostic_message:
          "fetch failed at https://example.invalid/hook?key=UNCONFIGURED_QUERY_SENTINEL",
        response: `${secrets.join(" ")} ${"x".repeat(1000)}`,
      },
    });

    const line = sink.mock.calls[0]?.[0] ?? "";
    for (const secret of secrets) expect(line).not.toContain(secret);
    expect(line).not.toContain("UNCONFIGURED_QUERY_SENTINEL");
    expect(line).toContain("incident-test");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("[TRUNCATED]");
  });

  it("keeps LLM diagnostics safe without logging output, prompt, or credentials", () => {
    const sink = vi.fn<(line: string) => void>();
    const logger = createLogger({
      sink,
      secrets: ["llm-api-key-sentinel", "https://wecom.example.test/hook?key=webhook-sentinel"],
    });
    const error = new AppError("llm_output_schema_invalid", "safe message", false, undefined, {
      externalService: "llm",
      validationStage: "schema",
      schemaIssuePaths: ["risk_level", "confidence"],
      contentLength: 123,
      completionTokens: 77,
      reasoningTokens: 12,
    });

    logger.error("llm_output_failed", {
      error,
      prompt: "full prompt must not be logged",
      raw_output: "full model output must not be logged",
      authorization: "Bearer llm-api-key-sentinel",
      webhook_url: "https://wecom.example.test/hook?key=webhook-sentinel",
    });

    const line = sink.mock.calls[0]?.[0] ?? "";
    expect(line).toContain("schemaIssuePaths");
    expect(line).toContain("contentLength");
    expect(line).not.toContain("full prompt must not be logged");
    expect(line).not.toContain("full model output must not be logged");
    expect(line).not.toContain("llm-api-key-sentinel");
    expect(line).not.toContain("webhook-sentinel");
  });
});
