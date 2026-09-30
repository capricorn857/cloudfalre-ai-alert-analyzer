import { z } from "zod";

import { AlertSchema } from "../../src/domain/alert";
import { UtcDateTimeSchema } from "../../src/domain/time";

const OldAnalysisWindowSchema = z
  .object({
    start: UtcDateTimeSchema,
    end: UtcDateTimeSchema,
  })
  .refine(({ start, end }) => Date.parse(start) <= Date.parse(end), {
    message: "analysis window start must not be after end",
  });

// Exact pre-change schema behavior from ce86425, retained as a compatibility oracle.
export const OldQueueMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    incidentId: z.string().min(1),
    correlationId: z.string().min(1),
    webhookReceivedAt: UtcDateTimeSchema,
    queryStartedAt: UtcDateTimeSchema,
    analysisWindow: OldAnalysisWindowSchema,
    configSnapshot: z.object({
      beforeMinutes: z.number().int().positive(),
      settleSeconds: z.number().int().nonnegative(),
      sampleLimit: z.number().int().positive(),
    }),
    alert: AlertSchema,
  })
  .superRefine((message, context) => {
    if (message.analysisWindow.end !== message.queryStartedAt) {
      context.addIssue({
        code: "custom",
        path: ["analysisWindow", "end"],
        message: "analysis window end must equal queryStartedAt",
      });
    }
    if (message.correlationId !== message.alert.correlationId) {
      context.addIssue({
        code: "custom",
        path: ["correlationId"],
        message: "correlationId must match alert correlationId",
      });
    }
  });

export const oldQueueMessage = {
  schemaVersion: 1,
  incidentId: "legacy-correlation-123",
  correlationId: "legacy-correlation-123",
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
    resource: "legacy.example.test",
    zoneTag: "legacy-zone-tag-test",
    correlationId: "legacy-correlation-123",
    payloadEventsCount: 394,
  },
} as const;
