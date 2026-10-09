import { ATTENTION_SCOPE, ScopedDiscoverySchema } from "../domain/event-scope";
import { decideSuppression } from "../analysis/suppression";
import type { RulesConfig } from "../config/rules";
import type { QueueMessage } from "../domain/queue-message";
import { AppError, toExternalFailure } from "../observability/errors";
import { HostIncidentSchema, HostCollectionSchema, type HostCollection } from "../domain/host-analysis";
import type { HostAnalyticsClient } from "../clients/contracts";
import type { HostSnapshotAnalysisResult } from "../domain/analysis-result";
import { analyzeHost, selectHosts, summarizeCoverage } from "../analysis/host-analysis";

export { analyzeHostWafAlert as analyzeWafAlert };

export async function analyzeHostWafAlert(message: QueueMessage, client: HostAnalyticsClient, rulesConfig: RulesConfig): Promise<HostSnapshotAnalysisResult> {
  const collectionMetrics = { requestCount: 0, nodeSelectionCount: 0 };
  const input = { zoneTag: message.alert.zoneTag, analysisWindow: message.analysisWindow,
    sampleLimit: message.configSnapshot.sampleLimit, deadlineAt: Date.now() + 90_000, metrics: collectionMetrics };
  let discovery;
  try { discovery = ScopedDiscoverySchema.parse(await client.discoverZone(input)); }
  catch (error) {
    const failure = toExternalFailure(error, "cloudflare");
    return { status: "collection_failed", message, errorCode: failure.errorCode, failure, collectionMetrics };
  }
  const decision = decideSuppression(discovery);
  if (decision.kind === "suppress") return { status: "suppressed", message, discovery, reason: decision.reason, collectionMetrics };
  if (decision.kind === "degrade") return { status: "suppression_ineligible", message, discovery, reason: decision.reason, collectionMetrics };
  const selection = selectHosts(discovery, message.configSnapshot.hostLimit);
  const selected = discovery.zoneTotalEvents === 0 ? [] : selection.hosts;
  const results: HostCollection[] = [];
  let cursor = 0;
  async function collect(): Promise<void> {
    while (cursor < selected.length) {
      const index = cursor++;
      const host = selected[index];
      if (host === undefined) return;
      try {
        const parsed = HostCollectionSchema.safeParse(await client.collectHostSnapshot(input, host));
        if (!parsed.success || parsed.data.hostId !== host.hostId || parsed.data.host !== host.host || parsed.data.discoveryCount !== host.discoveryCount) {
          throw new AppError("cloudflare_response_invalid", "Host collection identity or shape invalid", false, undefined, { externalService: "cloudflare", failureKind: "invalid_response" });
        }
        results[index] = parsed.data;
      } catch (error) {
        const classified = toExternalFailure(error, "cloudflare");
        results[index] = { ...ATTENTION_SCOPE, ...host, hostTotalEvents: null, aggregates: null, samples: [], samplesStatus: "not_requested", collectionStatus: "failed", errorCode: classified.errorCode,
          failure: { ...classified, externalService: "cloudflare" } };
      }
    }
  }
  await Promise.all([collect(), collect()]);
  const hosts = results.map((result) => analyzeHost(result, discovery.zoneTotalEvents, message.analysisWindow, rulesConfig));
  const discoveryConsistent = discovery.topHosts.reduce((sum, host) => sum + host.count, 0) <= discovery.zoneTotalEvents;
  const summary = summarizeCoverage(discovery.zoneTotalEvents, hosts, discoveryConsistent);
  const incident = HostIncidentSchema.parse({ ...message.alert, incidentId: message.incidentId, correlationId: message.correlationId,
    queryStartedAt: message.queryStartedAt, analysisWindow: message.analysisWindow,
    hosts, zone: { ...ATTENTION_SCOPE, rawTotalEvents: discovery.rawTotalEvents, blockedTotalEvents: discovery.blockedTotalEvents, countQuality: discovery.countQuality, ...summary, zoneTotalEvents: discovery.zoneTotalEvents, discoveredHosts: discovery.topHosts,
      selectedHostCount: selected.length, topHostsTruncated: selection.topHostsTruncated, invalidHostEvents: selection.invalidHostEvents } });
  const partial = !discoveryConsistent || summary.failedHostCount > 0 || summary.qualityFailedHostCount > 0 || summary.sampleFailedHostCount > 0 || summary.coverage.status === "inconsistent";
  return { status: partial ? "partial" : discovery.zoneTotalEvents === 0 ? "empty" : "success", message, incident, collectionMetrics };
}
