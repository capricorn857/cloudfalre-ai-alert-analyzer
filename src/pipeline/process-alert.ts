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
import {
  toExternalFailure,
  type ExternalFailure,
} from "../observability/errors";
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

function failureLogContext(failure: ExternalFailure): Record<string, unknown> {
  return {
    external_service: failure.externalService,
    error_code: failure.errorCode,
    failure_kind: failure.failureKind,
    retryable: failure.retryable,
    duration_ms: failure.durationMs,
    ...(failure.httpStatus === undefined ? {} : { http_status: failure.httpStatus }),
    ...(failure.responseCategory === undefined
      ? {}
      : { response_category: failure.responseCategory }),
  };
}

function logExternalFailure(
  logger: Logger,
  message: QueueMessage,
  failure: ExternalFailure,
): void {
  try {
    logger.warn("external_api_failed", {
      incident_id: message.incidentId,
      correlation_id: message.correlationId,
      analysis_window: message.analysisWindow,
      ...failureLogContext(failure),
    });
  } catch {
    // Observability must not change the dependency failure path.
  }
}

export async function processAlert(
  message: QueueMessage,
  dependencies: ProcessAlertDependencies,
): Promise<ProcessResult> {
  validateFixedWindow(message);
  const snapshot = await analyzeWafAlert(message, dependencies.cloudflare, dependencies.rulesConfig);
  if (snapshot.status === "collection_failed") {
    logExternalFailure(dependencies.logger, message, snapshot.failure);
  }
  const ai = await runAIAnalysis(snapshot, dependencies.ai);
  if (ai.status === "unavailable" && ai.failure !== undefined) {
    logExternalFailure(dependencies.logger, message, ai.failure);
  }
  const formatted = formatWeComMessage(
    { snapshot, ai },
    dependencies.formatterOptions,
  );
  try {
    await dependencies.notification.send(formatted);
  } catch (error) {
    const failure = toExternalFailure(error, "wecom");
    try {
      dependencies.logger.error("notification_failed", {
        incident_id: message.incidentId,
        correlation_id: message.correlationId,
        analysis_window: message.analysisWindow,
        cloudflare_api_status: snapshot.status,
        llm_api_status: ai.status,
        wecom_status: "failed",
        ...failureLogContext(failure),
        ...(snapshot.status === "collection_failed"
          ? { snapshot_error_code: snapshot.errorCode }
          : {}),
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
      response_category: "success",
    });
  } catch {
    // Notification success is an irreversible side effect; logging cannot replay it.
  }

  return { status: "sent", snapshotStatus: snapshot.status, aiStatus: ai.status };
}
