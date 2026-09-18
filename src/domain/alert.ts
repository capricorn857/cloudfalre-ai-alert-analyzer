import { z } from "zod";

import { UtcDateTimeSchema, ZonedDateTimeSchema } from "./time";

const CLOUDFLARE_WEBHOOK_TEST_MARKER =
  "This is a test message sent from [https://cloudflare.com](https://cloudflare.com).";

export const CloudflareWebhookTestPayloadSchema = z.object({
  text: z.string().refine((value) => value.includes(CLOUDFLARE_WEBHOOK_TEST_MARKER)),
});

export function isCloudflareWebhookTestPayload(payload: unknown): boolean {
  return CloudflareWebhookTestPayloadSchema.safeParse(payload).success;
}

const EventCountSchema = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/u)])
  .transform((value) => Number(value));

export const CloudflareAlertPayloadSchema = z
  .object({
    name: z.string().min(1).optional(),
    data: z.object({
      account_name: z.string().min(1).optional(),
      actions: z.string().min(1).optional(),
      alert_start_time: ZonedDateTimeSchema,
      events_count: EventCountSchema,
      zone_name: z.string().min(1),
      zone_tag: z.string().min(1),
      dashboard_link: z.url().optional(),
    }),
    alert_type: z.string().min(1),
    alert_event: z.string().min(1),
    alert_correlation_id: z.string().min(1),
  });

export type CloudflareAlertPayload = z.infer<typeof CloudflareAlertPayloadSchema>;

export const AlertSchema = z.object({
  provider: z.literal("cloudflare"),
  alertType: z.literal("waf_attack"),
  alertEvent: z.string().min(1),
  alertTime: UtcDateTimeSchema,
  resource: z.string().min(1),
  zoneTag: z.string().min(1),
  correlationId: z.string().min(1),
  payloadEventsCount: z.number().int().nonnegative(),
  dashboardLink: z.url().optional(),
});

export type Alert = z.infer<typeof AlertSchema>;
