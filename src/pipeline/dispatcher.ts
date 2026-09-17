import { AlertSchema, CloudflareAlertPayloadSchema, type Alert } from "../domain/alert";

export function mapCloudflareAlert(input: unknown): Alert | null {
  const payload = CloudflareAlertPayloadSchema.parse(input);
  if (payload.alert_type !== "clickhouse_alert_fw_anomaly") return null;

  return AlertSchema.parse({
    provider: "cloudflare",
    alertType: "waf_attack",
    alertEvent: payload.alert_event,
    alertTime: new Date(payload.data.alert_start_time).toISOString(),
    resource: payload.data.zone_name,
    zoneTag: payload.data.zone_tag,
    correlationId: payload.alert_correlation_id,
    payloadEventsCount: payload.data.events_count,
    ...(payload.data.dashboard_link === undefined
      ? {}
      : { dashboardLink: payload.data.dashboard_link }),
  });
}
