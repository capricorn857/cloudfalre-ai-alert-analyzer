import { z } from "zod";

import { AnalysisWindowSchema } from "./queue-message";
import { UtcDateTimeSchema } from "./time";

export const EvidenceItemSchema = z.object({
  value: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export const SecurityEventSampleSchema = z.object({
  datetime: UtcDateTimeSchema,
  action: z.string().min(1),
  clientIP: z.string().min(1),
  clientCountryName: z.string().min(1).nullable(),
  clientAsn: z.string().min(1).nullable(),
  clientRequestHTTPHost: z.string().min(1).nullable(),
  clientRequestPath: z.string().min(1).nullable(),
  source: z.string().min(1).nullable(),
  userAgent: z.string().min(1).nullable(),
});

export const IncidentSchema = z.object({
  incidentId: z.string().min(1),
  correlationId: z.string().min(1),
  provider: z.literal("cloudflare"),
  alertType: z.literal("waf_attack"),
  resource: z.string().min(1),
  zoneTag: z.string().min(1),
  alertTime: UtcDateTimeSchema,
  queryStartedAt: UtcDateTimeSchema,
  analysisWindow: AnalysisWindowSchema,
  payloadEventsCount: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  dashboardLink: z.url().optional(),
  evidence: z.object({
    topIps: z.array(EvidenceItemSchema),
    topPaths: z.array(EvidenceItemSchema),
    topHosts: z.array(EvidenceItemSchema),
    topCountries: z.array(EvidenceItemSchema),
    topAsns: z.array(EvidenceItemSchema),
    actions: z.array(EvidenceItemSchema),
    sources: z.array(EvidenceItemSchema),
  }),
  samples: z.array(SecurityEventSampleSchema),
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type SecurityEventSample = z.infer<typeof SecurityEventSampleSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
