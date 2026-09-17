import { describe, expect, it } from "vitest";

import {
  AppError,
  classifyHttpError,
  classifyUnknownError,
} from "../../../src/observability/errors";

describe("error classification", () => {
  it.each([429, 500, 502, 503, 504])("classifies HTTP %i as retryable", (status) => {
    const error = classifyHttpError("cloudflare", status, 37);

    expect(error.retryable).toBe(true);
    expect(error.code).toBe("cloudflare_http_retryable");
    expect(error).toMatchObject({
      externalService: "cloudflare",
      failureKind: "http",
      httpStatus: status,
      status,
      durationMs: 37,
    });
  });

  it.each([400, 401, 403, 404])("classifies HTTP %i as permanent", (status) => {
    const error = classifyHttpError("cloudflare", status);

    expect(error.retryable).toBe(false);
    expect(error.code).toBe("cloudflare_http_permanent");
  });

  it("preserves stable codes for timeout, input, degradation, and post-send errors", () => {
    expect(
      classifyUnknownError(new DOMException("timed out", "TimeoutError"), "llm", 12),
    ).toMatchObject({
      code: "llm_timeout",
      externalService: "llm",
      failureKind: "timeout",
      retryable: true,
      durationMs: 12,
    });
    expect(new AppError("input_invalid", "bad input", false).retryable).toBe(false);
    expect(new AppError("ai_degraded", "model unavailable", false).code).toBe("ai_degraded");
    expect(new AppError("post_send_noncritical", "log failed", false).retryable).toBe(false);
  });

  it("classifies fetch TypeError without retaining sensitive exception text", () => {
    const sentinel = "https://example.invalid/hook?key=sentinel-key";
    const error = classifyUnknownError(new TypeError(`fetch failed for ${sentinel}`), "wecom", 21);

    expect(error).toMatchObject({
      code: "wecom_network",
      externalService: "wecom",
      failureKind: "network",
      retryable: true,
      durationMs: 21,
    });
    expect(JSON.stringify(error)).not.toContain(sentinel);
    expect(error.message).not.toContain(sentinel);
  });

  it.each([
    ["ENOTFOUND", "dns"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
    ["ECONNREFUSED", "connection"],
  ] as const)("classifies runtime cause code %s as %s", (causeCode, failureKind) => {
    const runtimeError = new TypeError("fetch failed", { cause: { code: causeCode } });

    expect(classifyUnknownError(runtimeError, "wecom", 9)).toMatchObject({
      code: `wecom_${failureKind}`,
      externalService: "wecom",
      failureKind,
      retryable: true,
      durationMs: 9,
    });
  });

  it("uses a stable unknown fallback for non-fetch exceptions", () => {
    expect(classifyUnknownError(new Error("opaque failure"), "cloudflare", 4)).toMatchObject({
      code: "cloudflare_unexpected",
      externalService: "cloudflare",
      failureKind: "unknown",
      retryable: false,
      durationMs: 4,
    });
  });
});
