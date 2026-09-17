import type { CloudflareSnapshot } from "../clients/cloudflare-graphql";
import { IncidentSchema, type Incident } from "../domain/incident";
import type { QueueMessage } from "../domain/queue-message";

export function normalizeIncident(message: QueueMessage, snapshot: CloudflareSnapshot): Incident {
  return IncidentSchema.parse({
    incidentId: message.incidentId,
    correlationId: message.correlationId,
    provider: message.alert.provider,
    alertType: message.alert.alertType,
    resource: message.alert.resource,
    zoneTag: message.alert.zoneTag,
    alertTime: message.alert.alertTime,
    queryStartedAt: message.queryStartedAt,
    analysisWindow: message.analysisWindow,
    payloadEventsCount: message.alert.payloadEventsCount,
    totalEvents: snapshot.totalEvents,
    ...(message.alert.dashboardLink === undefined
      ? {}
      : { dashboardLink: message.alert.dashboardLink }),
    evidence: {
      topIps: snapshot.topIps,
      topPaths: snapshot.topPaths,
      topHosts: snapshot.topHosts,
      topCountries: snapshot.topCountries,
      topAsns: snapshot.topAsns,
      actions: snapshot.actions,
      sources: snapshot.sources,
    },
    samples: snapshot.samples,
  });
}
