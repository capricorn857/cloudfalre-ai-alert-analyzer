import { afterEach, describe, expect, it, vi } from "vitest";

import { WeComClient } from "../../src/clients/wecom";
import { AppError } from "../../src/observability/errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

function result(errcode = 0, status = 200): Response {
  return new Response(JSON.stringify({ errcode, errmsg: errcode === 0 ? "ok" : "failed" }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyAsString(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") throw new Error("Expected a string request body");
  return body;
}

describe("WeComClient", () => {
  it("calls the default Workers fetch without an invalid receiver", async () => {
    const runtimeFetch = vi.fn(function (this: unknown): Promise<Response> {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation: function called with incorrect this reference");
      }
      return Promise.resolve(result());
    });
    vi.stubGlobal("fetch", runtimeFetch);
    const client = new WeComClient({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      timeoutMs: 1000,
      retries: 0,
    });

    await expect(client.send("formatted-message")).resolves.toBeUndefined();
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });

  it("sends an already formatted text message", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(result());
    const client = new WeComClient({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      fetchFn,
      timeoutMs: 1000,
      retries: 1,
    });

    await client.send("formatted-message");

    const requestBody = JSON.parse(bodyAsString(fetchFn.mock.calls[0]?.[1]?.body)) as unknown;
    expect(requestBody).toEqual({ msgtype: "text", text: { content: "formatted-message" } });
  });

  it("retries transient failures with exactly the same body", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(result(0, 500))
      .mockResolvedValueOnce(result());
    const client = new WeComClient({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      fetchFn,
      timeoutMs: 1000,
      retries: 1,
      sleep: () => Promise.resolve(),
    });

    await client.send("formatted-message");

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(bodyAsString(fetchFn.mock.calls[0]?.[1]?.body)).toBe(
      bodyAsString(fetchFn.mock.calls[1]?.[1]?.body),
    );
  });

  it("does not retry permanent HTTP or protocol errors", async () => {
    for (const response of [result(0, 400), result(93000)]) {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
      const client = new WeComClient({
        webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
        fetchFn,
        timeoutMs: 1000,
        retries: 2,
        sleep: () => Promise.resolve(),
      });

      await expect(client.send("formatted-message")).rejects.toBeDefined();
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  });

  it("throws after transient retry exhaustion", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(result(0, 503));
    const client = new WeComClient({
      webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      fetchFn,
      timeoutMs: 1000,
      retries: 2,
      sleep: () => Promise.resolve(),
    });

    await expect(client.send("formatted-message")).rejects.toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("classifies a fetch TypeError without retaining sensitive text", async () => {
    const sentinel = "https://example.invalid/hook?key=wecom-sensitive-sentinel";
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError(`fetch failed for ${sentinel}`));
    const client = new WeComClient({
      webhookUrl: "https://example.invalid/hook?key=test-only",
      fetchFn,
      timeoutMs: 1000,
      retries: 0,
    });

    const error = await client.send("formatted-message").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "wecom_network",
      externalService: "wecom",
      failureKind: "network",
      retryable: true,
      responseCategory: "transport_error",
    });
    expect((error as AppError).durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it("classifies timeout as a retryable transport error", async () => {
    const client = new WeComClient({
      webhookUrl: "https://example.invalid/hook?key=test-only",
      fetchFn: vi
        .fn<typeof fetch>()
        .mockRejectedValue(new DOMException("timed out", "TimeoutError")),
      timeoutMs: 1000,
      retries: 0,
    });

    await expect(client.send("formatted-message")).rejects.toMatchObject({
      code: "wecom_timeout",
      failureKind: "timeout",
      retryable: true,
      responseCategory: "transport_error",
    });
  });

  it.each([
    [400, false],
    [429, true],
    [500, true],
  ] as const)("classifies HTTP %i with its status and retryability", async (status, retryable) => {
    const client = new WeComClient({
      webhookUrl: "https://example.invalid/hook?key=test-only",
      fetchFn: vi.fn<typeof fetch>().mockResolvedValue(result(0, status)),
      timeoutMs: 1000,
      retries: 0,
    });

    await expect(client.send("formatted-message")).rejects.toMatchObject({
      externalService: "wecom",
      failureKind: "http",
      httpStatus: status,
      retryable,
      responseCategory: "http_error",
    });
  });

  it.each([
    [new Response("not-json", { status: 200 }), "invalid_response", "invalid_response"],
    [result(93000), "service_error", "api_error"],
  ] as const)(
    "normalizes invalid and rejected responses without preserving the raw response",
    async (response, failureKind, responseCategory) => {
      const client = new WeComClient({
        webhookUrl: "https://example.invalid/hook?key=test-only",
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response),
        timeoutMs: 1000,
        retries: 0,
      });

      const error = await client.send("formatted-message").catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        externalService: "wecom",
        failureKind,
        retryable: false,
        responseCategory,
      });
      expect(JSON.stringify(error)).not.toContain("failed");
      expect(JSON.stringify(error)).not.toContain("93000");
    },
  );
});
