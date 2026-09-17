import { describe, expect, it } from "vitest";

import { buildQueueMessage, validateFixedWindow } from "../../../src/pipeline/window";

const payload = {
  name: "cloudflare-alert",
  data: {
    alert_start_time: "2026-09-14T09:18:46+00:00",
    events_count: "394",
    zone_name: "example.test",
    zone_tag: "zone-test",
  },
  alert_type: "clickhouse_alert_fw_anomaly",
  alert_event: "ALERT_STATE_EVENT_START",
  alert_correlation_id: "correlation-123",
};

describe("fixed analysis window", () => {
  it("builds the default UTC snapshot window once", () => {
    const message = buildQueueMessage(
      payload,
      { beforeMinutes: 30, settleSeconds: 60, sampleLimit: 50 },
      new Date("2026-09-14T09:19:00Z"),
    );

    expect(message.webhookReceivedAt).toBe("2026-09-14T09:19:00.000Z");
    expect(message.queryStartedAt).toBe("2026-09-14T09:20:00.000Z");
    expect(message.analysisWindow).toEqual({
      start: "2026-09-14T08:48:46.000Z",
      end: "2026-09-14T09:20:00.000Z",
    });
    expect(message.incidentId).toBe("correlation-123");
  });

  it("uses configured values and validates without mutating the message", () => {
    const message = buildQueueMessage(
      payload,
      { beforeMinutes: 15, settleSeconds: 120, sampleLimit: 10 },
      new Date("2026-09-14T09:19:00Z"),
    );
    const before = structuredClone(message);

    validateFixedWindow(message);

    expect(message).toEqual(before);
    expect(message.analysisWindow.start).toBe("2026-09-14T09:03:46.000Z");
    expect(message.queryStartedAt).toBe("2026-09-14T09:21:00.000Z");
  });

  it("rejects a message whose fixed end was changed", () => {
    const message = buildQueueMessage(
      payload,
      { beforeMinutes: 30, settleSeconds: 60, sampleLimit: 50 },
      new Date("2026-09-14T09:19:00Z"),
    );

    expect(() => {
      validateFixedWindow({
        ...message,
        analysisWindow: { ...message.analysisWindow, end: "2026-09-14T09:25:00.000Z" },
      });
    }).toThrow();
  });
});
