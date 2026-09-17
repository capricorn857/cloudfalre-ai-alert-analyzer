import { describe, expect, it } from "vitest";

import { mapCloudflareAlert } from "../../../src/pipeline/dispatcher";

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

describe("mapCloudflareAlert", () => {
  it("maps the supported WAF anomaly to waf_attack", () => {
    expect(mapCloudflareAlert(payload)).toMatchObject({
      provider: "cloudflare",
      alertType: "waf_attack",
      resource: "example.test",
      payloadEventsCount: 394,
    });
  });

  it("returns null for unsupported alert types", () => {
    expect(mapCloudflareAlert({ ...payload, alert_type: "other_alert" })).toBeNull();
  });
});
