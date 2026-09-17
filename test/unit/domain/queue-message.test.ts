import { describe, expect, it } from "vitest";

import { QueueMessageSchema } from "../../../src/domain/queue-message";

const message = {
  schemaVersion: 1,
  incidentId: "correlation-123",
  correlationId: "correlation-123",
  webhookReceivedAt: "2026-09-14T09:19:00.000Z",
  queryStartedAt: "2026-09-14T09:20:00.000Z",
  analysisWindow: {
    start: "2026-09-14T08:48:46.000Z",
    end: "2026-09-14T09:20:00.000Z",
  },
  configSnapshot: { beforeMinutes: 30, settleSeconds: 60, sampleLimit: 50 },
  alert: {
    provider: "cloudflare",
    alertType: "waf_attack",
    alertEvent: "ALERT_STATE_EVENT_START",
    alertTime: "2026-09-14T09:18:46.000Z",
    resource: "example.test",
    zoneTag: "zone-tag-test",
    correlationId: "correlation-123",
    payloadEventsCount: 394,
  },
};

describe("QueueMessageSchema", () => {
  it("accepts version 1 with a consistent UTC window", () => {
    expect(QueueMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects unknown schema versions", () => {
    expect(() => QueueMessageSchema.parse({ ...message, schemaVersion: 2 })).toThrow();
  });

  it("rejects a reversed analysis window", () => {
    expect(() =>
      QueueMessageSchema.parse({
        ...message,
        analysisWindow: { start: message.analysisWindow.end, end: message.analysisWindow.start },
      }),
    ).toThrow();
  });

  it("rejects non-UTC internal timestamps", () => {
    expect(() =>
      QueueMessageSchema.parse({ ...message, queryStartedAt: "2026-09-14T17:20:00+08:00" }),
    ).toThrow();
  });
});

export { message as validQueueMessage };
