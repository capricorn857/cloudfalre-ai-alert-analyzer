import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../../src/index";
import aggregateSuccess from "../fixtures/graphql/aggregate-success.json";
import samplesSuccess from "../fixtures/graphql/samples-success.json";
import validOutput from "../fixtures/llm/valid-output.json";
import { queueMessage } from "../fixtures/domain";

const payload = {
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

const business = {
  beforeMinutes: 30,
  settleSeconds: 60,
  sampleLimit: 50,
  requestTimeoutMs: 10_000,
  retryCount: 1,
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
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("full Worker pipeline", () => {
  it("accepts, analyzes, and notifies using one fixed snapshot", async () => {
    let queued: unknown;
    const queue = {
      send: vi.fn((body: unknown) => {
        queued = body;
        return Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
      }),
    };
    const env = {
      ALERT_QUEUE: queue,
      CLOUDFLARE_API_TOKEN: "cf-test-secret",
      LLM_API_KEY: "llm-test-secret",
      WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_MODEL: "test-model",
      BUSINESS_CONFIG: business,
    };
    const response = await worker.fetch?.(
      new Request("https://worker.test/api/v1/alerts/cloudflare", {
        method: "POST",
        body: JSON.stringify(payload),
      }) as unknown as Request<unknown, IncomingRequestCfProperties>,
      env as unknown as CloudflareWorkerEnv,
      {} as ExecutionContext,
    );
    expect(response?.status).toBe(202);

    let sentMessage = "";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(aggregateSuccess))
      .mockResolvedValueOnce(jsonResponse(samplesSuccess))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(validOutput) } }] }),
      )
      .mockImplementationOnce((_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected WeCom request body");
        const request = JSON.parse(init.body) as { text: { content: string } };
        sentMessage = request.text.content;
        return Promise.resolve(jsonResponse({ errcode: 0, errmsg: "ok" }));
      });
    const message = {
      body: queued,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await worker.queue?.(
      { queue: "test", messages: [message] } as unknown as MessageBatch,
      env as unknown as CloudflareWorkerEnv,
      {} as ExecutionContext,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(sentMessage).toContain("incident_id: correlation-123");
    expect(sentMessage).toContain("快照事件数: 400");
  });

  it("acks final WeCom failure without replaying GraphQL or AI", async () => {
    const env = {
      ALERT_QUEUE: { send: vi.fn() },
      CLOUDFLARE_API_TOKEN: "cf-test-secret",
      LLM_API_KEY: "llm-test-secret",
      WECOM_WEBHOOK_URL: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-only",
      LLM_BASE_URL: "https://llm.example.test/v1",
      LLM_MODEL: "test-model",
      BUSINESS_CONFIG: business,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(aggregateSuccess))
      .mockResolvedValueOnce(jsonResponse(samplesSuccess))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: JSON.stringify(validOutput) } }] }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const message = {
      body: queueMessage,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };

    await worker.queue?.(
      { queue: "test", messages: [message] } as unknown as MessageBatch,
      env as unknown as CloudflareWorkerEnv,
      {} as ExecutionContext,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
