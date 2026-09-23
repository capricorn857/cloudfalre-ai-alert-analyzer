import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/observability/logger";
import { AppError } from "../../src/observability/errors";
import { LLMClient } from "../../src/clients/llm";
import { processAlert } from "../../src/pipeline/process-alert";
import { queueMessage, rulesConfig, snapshot } from "../fixtures/domain";
import validOutput from "../fixtures/llm/valid-output.json";

describe("log redaction integration", () => {
  it("logs only safe diagnostics through the actual Evidence failure and fallback pipeline", async () => {
    const sink = vi.fn<(line: string) => void>();
    const sensitive = ["203.0.113.99", "/private-sentinel", "PROMPT_SENTINEL", "TOKEN_SENTINEL", "Authorization: Bearer AUTH_SENTINEL", "API_KEY_SENTINEL", "https://wecom.example.test/hook?key=WEBHOOK_SENTINEL"];
    const content = JSON.stringify({ ...validOutput, summary: sensitive.join(" ") });
    let prompt = "";
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("expected JSON request body");
      const request = JSON.parse(body) as { messages: { content: string }[] };
      prompt = JSON.stringify(request.messages);
      return Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content } }], usage: { completion_tokens: 77, reasoning_tokens: 12 } }));
    });
    const ai = new LLMClient({ baseUrl: "https://llm.example.test/v1", model: "test", apiKey: "API_KEY_SENTINEL", fetchFn, timeoutMs: 1000, maxOutputTokens: 2048 });
    const notification = { send: vi.fn().mockResolvedValue(undefined) };
    await processAlert(queueMessage, {
      cloudflare: { collectSnapshot: vi.fn().mockResolvedValue({ ...snapshot, samples: snapshot.samples.map((sample) => ({ ...sample, userAgent: "PROMPT_SENTINEL" })) }) },
      ai, notification, logger: createLogger({ sink }), rulesConfig,
      formatterOptions: { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 },
    });
    const logs = sink.mock.calls.map(([line]) => line).join("\n");
    expect(prompt).toContain("PROMPT_SENTINEL");
    expect(logs).not.toContain(content);
    expect(logs).not.toContain(prompt);
    for (const value of sensitive) expect(logs).not.toContain(value);
    const firstLine = sink.mock.calls[0]?.[0] ?? "";
    const failure = JSON.parse(firstLine) as Record<string, unknown>;
    expect(failure).toMatchObject({ error_code: "ai_evidence_invalid", validation_stage: "evidence", evidence_failure_reason: "unsupported_entity", content_length: content.length, completion_tokens: 77, reasoning_tokens: 12 });
    expect(typeof failure.duration_ms).toBe("number");
    expect(Object.keys(failure).sort()).toEqual(["level", "event", "incident_id", "correlation_id", "analysis_window", "external_service", "error_code", "failure_kind", "retryable", "duration_ms", "finish_reason", "refusal_present", "content_length", "completion_tokens", "reasoning_tokens", "validation_stage", "evidence_failure_reason"].sort());
    expect(notification.send).toHaveBeenCalledOnce();
    expect(String(notification.send.mock.calls[0]?.[0])).not.toContain("203.0.113.99");
  });

  it("does not serialize arbitrary strings as Evidence failure reasons", () => {
    const sink = vi.fn<(line: string) => void>();
    const error = Object.assign(new Error("safe"), { evidenceFailureReason: "UNSUPPORTED_ENTITY_VALUE_SENTINEL" });
    createLogger({ sink }).error("failure", { error });
    expect(sink.mock.calls[0]?.[0]).not.toContain("UNSUPPORTED_ENTITY_VALUE_SENTINEL");
  });
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
      evidenceFailureReason: "unsupported_entity",
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
    expect(line).toContain("evidenceFailureReason");
    expect(line).toContain("contentLength");
    expect(line).not.toContain("full prompt must not be logged");
    expect(line).not.toContain("full model output must not be logged");
    expect(line).not.toContain("llm-api-key-sentinel");
    expect(line).not.toContain("webhook-sentinel");
  });
});
