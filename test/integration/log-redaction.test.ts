import { describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/observability/logger";

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
});
