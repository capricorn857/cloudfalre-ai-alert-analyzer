import { normalizeIncident } from "../analysis/normalizer";
import { evaluateRules } from "../analysis/rules";
import { calculateStatistics } from "../analysis/statistics";
import type { CloudflareSnapshot } from "../clients/cloudflare-graphql";
import type { CloudflareAnalyticsClient } from "../clients/contracts";
import type { RulesConfig } from "../config/rules";
import type { SnapshotAnalysisResult } from "../domain/analysis-result";
import type { QueueMessage } from "../domain/queue-message";
import { AppError } from "../observability/errors";

export async function analyzeWafAlert(
  message: QueueMessage,
  client: CloudflareAnalyticsClient,
  rulesConfig: RulesConfig,
): Promise<SnapshotAnalysisResult> {
  let snapshot: CloudflareSnapshot;
  try {
    snapshot = await client.collectSnapshot({
      zoneTag: message.alert.zoneTag,
      analysisWindow: message.analysisWindow,
      sampleLimit: message.configSnapshot.sampleLimit,
    });
  } catch (error) {
    return {
      status: "collection_failed",
      message,
      errorCode: error instanceof AppError ? error.code : "cloudflare_unexpected",
    };
  }

  const incident = normalizeIncident(message, snapshot);
  const statistics = calculateStatistics(incident);
  const findings = evaluateRules(statistics, rulesConfig);
  return {
    status: snapshot.totalEvents === 0 ? "empty" : "success",
    message,
    incident,
    statistics,
    findings,
  };
}
