import { describe, expect, it } from "vitest";

import { AlertSchema, CloudflareAlertPayloadSchema } from "../../../src/domain/alert";

const validPayload = {
  name: "cloudflare-alert",
  data: {
    account_name: "Example Account",
    actions: "allow",
    alert_start_time: "2026-09-14T09:18:46Z",
    events_count: "394",
    zone_name: "example.test",
    zone_tag: "zone-tag-test",
    dashboard_link: "https://dash.cloudflare.com/example/security/events",
  },
  alert_type: "clickhouse_alert_fw_anomaly",
  alert_event: "ALERT_STATE_EVENT_START",
  alert_correlation_id: "correlation-123",
};

describe("CloudflareAlertPayloadSchema", () => {
  it("parses required fields and coerces events_count", () => {
    const result = CloudflareAlertPayloadSchema.parse(validPayload);

    expect(result.data.events_count).toBe(394);
    expect(result.data.zone_name).toBe("example.test");
  });

  it("rejects a missing zone_tag", () => {
    const payload = structuredClone(validPayload);
    delete (payload.data as Partial<typeof payload.data>).zone_tag;

    expect(() => CloudflareAlertPayloadSchema.parse(payload)).toThrow();
  });

  it("rejects a timestamp without a timezone", () => {
    const payload = structuredClone(validPayload);
    payload.data.alert_start_time = "2026-09-14T09:18:46";

    expect(() => CloudflareAlertPayloadSchema.parse(payload)).toThrow();
  });

  it("accepts additional Cloudflare fields outside the required contract", () => {
    expect(
      CloudflareAlertPayloadSchema.parse({
        ...validPayload,
        product: "waf",
        data: { ...validPayload.data, additional_context: "ignored" },
      }).alert_type,
    ).toBe("clickhouse_alert_fw_anomaly");
  });
});

describe("AlertSchema", () => {
  it("accepts the normalized internal alert contract", () => {
    expect(
      AlertSchema.parse({
        provider: "cloudflare",
        alertType: "waf_attack",
        alertEvent: "ALERT_STATE_EVENT_START",
        alertTime: "2026-09-14T09:18:46.000Z",
        resource: "example.test",
        zoneTag: "zone-tag-test",
        correlationId: "correlation-123",
        payloadEventsCount: 394,
        dashboardLink: "https://dash.cloudflare.com/example/security/events",
      }),
    ).toMatchObject({ provider: "cloudflare", alertType: "waf_attack" });
  });
});
