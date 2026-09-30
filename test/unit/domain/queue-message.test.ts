import { describe, expect, it } from "vitest";

import { QueueMessageSchema } from "../../../src/domain/queue-message";
import { oldQueueMessage, OldQueueMessageSchema } from "../../fixtures/queue-v1";

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
    expect(QueueMessageSchema.parse(message)).toEqual({
      ...message,
      configSnapshot: { ...message.configSnapshot, hostLimit: 3 },
    });
  });

  it("uses the fixed legacy host limit for a message that predates the field", () => {
    const parsed = QueueMessageSchema.parse(oldQueueMessage);

    expect(parsed.configSnapshot.hostLimit).toBe(3);
    expect(parsed.analysisWindow).toEqual(oldQueueMessage.analysisWindow);
    expect(parsed.incidentId).toBe(oldQueueMessage.incidentId);
    expect(parsed.correlationId).toBe(oldQueueMessage.correlationId);
    expect(parsed.configSnapshot.sampleLimit).toBe(oldQueueMessage.configSnapshot.sampleLimit);
  });

  it("preserves a producer's configured host limit in the message snapshot", () => {
    const parsed = QueueMessageSchema.parse({
      ...message,
      configSnapshot: { ...message.configSnapshot, hostLimit: 5 },
    });

    expect(parsed.configSnapshot.hostLimit).toBe(5);
  });

  it("allows the actual old consumer schema to read and strip the new field", () => {
    const newMessage = QueueMessageSchema.parse({
      ...oldQueueMessage,
      configSnapshot: { ...oldQueueMessage.configSnapshot, hostLimit: 5 },
    });

    expect(OldQueueMessageSchema.parse(newMessage)).toEqual(oldQueueMessage);
  });

  it("rejects unknown schema versions", () => {
    expect(() => QueueMessageSchema.parse({ ...message, schemaVersion: 2 })).toThrow();
  });
  it("rejects sample limits outside the supported per-Host budget", () => {
    expect(QueueMessageSchema.safeParse({ ...message, configSnapshot: { ...message.configSnapshot, sampleLimit: 101 } }).success).toBe(false);
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
