import { runAIAnalysis } from "../analysis/ai-analyzer";
import { analyzeWafAlert } from "../analyzers/waf-analyzer";
import type {
  AIAnalysisClient,
  CloudflareAnalyticsClient,
  NotificationClient,
} from "../clients/contracts";
import type { RulesConfig } from "../config/rules";
import type { QueueMessage } from "../domain/queue-message";
import { formatWeComMessage, type FormatterOptions } from "../notification/formatter";
import type { Logger } from "../observability/logger";
import { validateFixedWindow } from "./window";

export interface ProcessAlertDependencies {
  readonly cloudflare: CloudflareAnalyticsClient;
  readonly ai: AIAnalysisClient;
  readonly notification: NotificationClient;
  readonly logger: Logger;
  readonly rulesConfig: RulesConfig;
  readonly formatterOptions: FormatterOptions;
}

export interface ProcessResult {
  readonly status: "sent" | "notification_failed";
  readonly snapshotStatus: "success" | "empty" | "collection_failed";
  readonly aiStatus: "available" | "unavailable";
}

export async function processAlert(
  message: QueueMessage,
  dependencies: ProcessAlertDependencies,
): Promise<ProcessResult> {
  validateFixedWindow(message);
  const snapshot = await analyzeWafAlert(message, dependencies.cloudflare, dependencies.rulesConfig);
  const ai = await runAIAnalysis(snapshot, dependencies.ai);
  const formatted = formatWeComMessage(
    { snapshot, ai },
    dependencies.formatterOptions,
  );
  try {
    await dependencies.notification.send(formatted);
  } catch (error) {
    try {
      dependencies.logger.error("notification_failed", {
        incident_id: message.incidentId,
        correlation_id: message.correlationId,
        analysis_window: message.analysisWindow,
        cloudflare_api_status: snapshot.status,
        llm_api_status: ai.status,
        wecom_status: "failed",
        error_code: "notification_failed",
        error,
      });
    } catch {
      // A logger failure cannot turn a handled notification failure into a replay.
    }
    return {
      status: "notification_failed",
      snapshotStatus: snapshot.status,
      aiStatus: ai.status,
    };
  }

  try {
    dependencies.logger.info("notification_sent", {
      incident_id: message.incidentId,
      correlation_id: message.correlationId,
      analysis_window: message.analysisWindow,
      cloudflare_api_status: snapshot.status,
      llm_api_status: ai.status,
      wecom_status: "sent",
    });
  } catch {
    // Notification success is an irreversible side effect; logging cannot replay it.
  }

  return { status: "sent", snapshotStatus: snapshot.status, aiStatus: ai.status };
}
