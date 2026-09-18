import { describe, expect, it, vi } from "vitest";

import { handleCloudflareAlert } from "../../src/api/cloudflare-alert";
import worker from "../../src/index";

const payload = {
  name: "cloudflare-alert",
  data: {
    alert_start_time: "2026-09-14T09:18:46Z",
    events_count: "394",
    zone_name: "example.test",
    zone_tag: "zone-test",
  },
  alert_type: "clickhouse_alert_fw_anomaly",
  alert_event: "ALERT_STATE_EVENT_START",
  alert_correlation_id: "correlation-123",
};

const officialWebhookTestPayload = {
  text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.",
};

const markdownLinkWebhookTestPayload = {
  text: "Hello World! This is a test message sent from [https://cloudflare.com](https://cloudflare.com). If you can see this, your webhook is configured properly.",
};

const queueResponse: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

function createEnv(send: Queue["send"]) {
  return {
    ALERT_QUEUE: { send },
    CLOUDFLARE_API_TOKEN: "cf-test-secret",
    LLM_API_KEY: "llm-test-secret",
    WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
    LLM_BASE_URL: "https://llm.example.test/v1",
    LLM_MODEL: "test-model",
    BUSINESS_CONFIG: {
      beforeMinutes: 30,
      settleSeconds: 60,
      sampleLimit: 50,
      requestTimeoutMs: 10_000,
      retryCount: 2,
      displayTimeZone: "Asia/Shanghai",
      rules: {
        ipConcentration: { medium: 30, high: 50 },
        pathConcentration: { medium: 30, high: 50 },
        countryConcentration: { medium: 40, high: 70 },
        asnConcentration: { medium: 40, high: 70 },
        allowRatio: { medium: 50, high: 80 },
        blockRatio: { medium: 50, high: 80 },
        userAgentConcentration: { medium: 50, high: 80 },
        requestRate: { medium: 5, high: 20 },
      },
    },
  };
}

const fixedClock = { now: () => new Date("2026-09-14T09:19:00Z") };

describe("Cloudflare alert route", () => {
  it("returns 404 for other paths and 405 for other methods", async () => {
    const send = vi.fn<Queue["send"]>();
    const env = createEnv(send);

    expect(
      (await handleCloudflareAlert(new Request("https://worker.test/other"), env, { clock: fixedClock }))
        .status,
    ).toBe(404);
    expect(
      (
        await handleCloudflareAlert(
          new Request("https://worker.test/api/v1/alerts/cloudflare"),
          env,
          { clock: fixedClock },
        )
      ).status,
    ).toBe(405);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects malformed, invalid, and oversized bodies without enqueueing", async () => {
    const send = vi.fn<Queue["send"]>();
    const env = createEnv(send);
    const url = "https://worker.test/api/v1/alerts/cloudflare";

    expect(
      (await handleCloudflareAlert(new Request(url, { method: "POST", body: "{" }), env, { clock: fixedClock }))
        .status,
    ).toBe(400);
    expect(
      (
        await handleCloudflareAlert(
          new Request(url, { method: "POST", body: JSON.stringify({ ...payload, data: {} }) }),
          env,
          { clock: fixedClock },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCloudflareAlert(
          new Request(url, {
            method: "POST",
            body: JSON.stringify(markdownLinkWebhookTestPayload),
          }),
          env,
          { clock: fixedClock },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCloudflareAlert(
          new Request(url, { method: "POST", body: JSON.stringify({ text: "hello" }) }),
          env,
          { clock: fixedClock },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCloudflareAlert(
          new Request(url, {
            method: "POST",
            body: JSON.stringify({ text: "ordinary alert text", data: { zone_name: "example.test" } }),
          }),
          env,
          { clock: fixedClock },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleCloudflareAlert(
          new Request(url, { method: "POST", body: JSON.stringify(payload) }),
          env,
          { clock: fixedClock, maxRequestBodyBytes: 10 },
        )
      ).status,
    ).toBe(413);
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts the official webhook test without queue or downstream side effects", async () => {
    const send = vi.fn<Queue["send"]>();
    const now = vi.fn(() => {
      throw new Error("the webhook test must not calculate an analysis window");
    });
    const outboundFetch = vi.spyOn(globalThis, "fetch");

    const result = await handleCloudflareAlert(
      new Request("https://worker.test/api/v1/alerts/cloudflare", {
        method: "POST",
        body: JSON.stringify(officialWebhookTestPayload),
      }),
      { ALERT_QUEUE: { send } },
      { clock: { now } },
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ message: "Webhook test accepted" });
    expect(send).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(outboundFetch).not.toHaveBeenCalled();
  });

  it("accepts unsupported types without enqueueing", async () => {
    const send = vi.fn<Queue["send"]>();
    const response = await handleCloudflareAlert(
      new Request("https://worker.test/api/v1/alerts/cloudflare", {
        method: "POST",
        body: JSON.stringify({ ...payload, alert_type: "other_alert" }),
      }),
      createEnv(send),
      { clock: fixedClock },
    );

    expect(response.status).toBe(202);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 202 only after enqueue succeeds with the fixed delay", async () => {
    const send = vi.fn<Queue["send"]>().mockResolvedValue(queueResponse);
    const response = await handleCloudflareAlert(
      new Request("https://worker.test/api/v1/alerts/cloudflare", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      createEnv(send),
      { clock: fixedClock },
    );

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1]).toEqual({ delaySeconds: 60 });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      queryStartedAt: "2026-09-14T09:20:00.000Z",
    });
  });

  it("returns 503 when enqueue fails", async () => {
    const send = vi.fn<Queue["send"]>().mockRejectedValue(new Error("queue unavailable"));
    const response = await handleCloudflareAlert(
      new Request("https://worker.test/api/v1/alerts/cloudflare", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      createEnv(send),
      { clock: fixedClock },
    );

    expect(response.status).toBe(503);
  });

  it("connects the module Worker fetch handler without downstream HTTP calls", async () => {
    const send = vi.fn<Queue["send"]>().mockResolvedValue(queueResponse);
    const outboundFetch = vi.spyOn(globalThis, "fetch");
    const request = new Request("https://worker.test/api/v1/alerts/cloudflare", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const result = await worker.fetch?.(
      request as unknown as Request<unknown, IncomingRequestCfProperties>,
      createEnv(send) as unknown as CloudflareWorkerEnv,
      {} as ExecutionContext,
    );

    expect(result?.status).toBe(202);
    expect(send).toHaveBeenCalledOnce();
    expect(outboundFetch).not.toHaveBeenCalled();
  });
});
