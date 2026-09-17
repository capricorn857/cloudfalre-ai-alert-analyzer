import type { CloudflareSnapshot } from "../../src/clients/cloudflare-graphql";
import type { QueueMessage } from "../../src/domain/queue-message";

export const queueMessage: QueueMessage = {
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
    zoneTag: "zone-test",
    correlationId: "correlation-123",
    payloadEventsCount: 394,
    dashboardLink: "https://dash.cloudflare.com/example/security/events",
  },
};

export const snapshot: CloudflareSnapshot = {
  totalEvents: 400,
  topIps: [
    { value: "192.0.2.10", count: 220 },
    { value: "198.51.100.20", count: 80 },
  ],
  topPaths: [{ value: "/api/login", count: 180 }],
  topHosts: [{ value: "example.test", count: 400 }],
  topCountries: [{ value: "US", count: 250 }],
  topAsns: [{ value: "AS64500", count: 250 }],
  actions: [
    { value: "allow", count: 350 },
    { value: "block", count: 30 },
    { value: "managed_challenge", count: 20 },
  ],
  sources: [{ value: "firewallCustom", count: 400 }],
  samples: [
    {
      datetime: "2026-09-14T09:19:10.000Z",
      action: "allow",
      clientIP: "192.0.2.10",
      clientCountryName: "US",
      clientAsn: "64500",
      clientRequestHTTPHost: "example.test",
      clientRequestPath: "/api/login",
      source: "firewallCustom",
      userAgent: "ExampleClient/1.0",
    },
    {
      datetime: "2026-09-14T09:19:11.000Z",
      action: "allow",
      clientIP: "192.0.2.10",
      clientCountryName: "US",
      clientAsn: "64500",
      clientRequestHTTPHost: "example.test",
      clientRequestPath: "/api/login",
      source: "firewallCustom",
      userAgent: "ExampleClient/1.0",
    },
  ],
};

export const rulesConfig = {
  ipConcentration: { medium: 30, high: 50 },
  pathConcentration: { medium: 30, high: 50 },
  countryConcentration: { medium: 40, high: 60 },
  asnConcentration: { medium: 40, high: 60 },
  allowRatio: { medium: 50, high: 80 },
  blockRatio: { medium: 50, high: 80 },
  userAgentConcentration: { medium: 50, high: 80 },
  requestRate: { medium: 0.1, high: 1 },
} as const;
