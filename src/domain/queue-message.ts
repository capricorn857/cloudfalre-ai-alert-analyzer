import { z } from "zod";

import { AlertSchema } from "./alert";
import { UtcDateTimeSchema } from "./time";

export const AnalysisWindowSchema = z
  .object({
    start: UtcDateTimeSchema,
    end: UtcDateTimeSchema,
  })
  .refine(({ start, end }) => Date.parse(start) <= Date.parse(end), {
    message: "analysis window start must not be after end",
  });

export type AnalysisWindow = z.infer<typeof AnalysisWindowSchema>;

export const QueueMessageSchema = z
  .object({
    schemaVersion: z.literal(1),
    incidentId: z.string().min(1),
    correlationId: z.string().min(1),
    webhookReceivedAt: UtcDateTimeSchema,
    queryStartedAt: UtcDateTimeSchema,
    analysisWindow: AnalysisWindowSchema,
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

export type QueueMessage = z.infer<typeof QueueMessageSchema>;
