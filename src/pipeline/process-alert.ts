import type {
  NotificationClient,
} from "../clients/contracts";
import type { RulesConfig } from "../config/rules";
import type { QueueMessage } from "../domain/queue-message";
import type { FormatterOptions } from "../notification/formatter";
import type { Logger } from "../observability/logger";
import {
  AppError,
  toExternalFailure,
  type ExternalFailure,
} from "../observability/errors";
import { validateFixedWindow } from "./window";
import { analyzeHostWafAlert } from "../analyzers/waf-analyzer";
import { runHostAIAnalysis } from "../analysis/ai-analyzer";
import { formatHostWeComMessage } from "../notification/host-formatter";
import type { HostAnalyticsClient, HostAIAnalysisClient } from "../clients/contracts";

export interface HostProcessAlertDependencies {
  readonly cloudflare: HostAnalyticsClient;
  readonly ai: HostAIAnalysisClient;
  readonly notification: NotificationClient;
  readonly logger: Logger;
  readonly rulesConfig: RulesConfig;
  readonly formatterOptions: FormatterOptions;
}

export async function processHostAlert(message: QueueMessage, dependencies: HostProcessAlertDependencies) {
  validateFixedWindow(message);
  const snapshot = await analyzeHostWafAlert(message, dependencies.cloudflare, dependencies.rulesConfig);
  const ai = await runHostAIAnalysis(snapshot, dependencies.ai);
  const context = { incident_id: message.incidentId, correlation_id: message.correlationId, analysis_window: message.analysisWindow,
    request_count: snapshot.collectionMetrics?.requestCount ?? 0, node_selection_count: snapshot.collectionMetrics?.nodeSelectionCount ?? 0 };
  try {
    if (snapshot.status === "collection_failed") logExternalFailure(dependencies.logger, message, snapshot.failure);
    else for (const host of snapshot.incident.hosts) {
      if (host.collection.failure !== undefined) {
        const { httpStatus, ...failure } = host.collection.failure;
        dependencies.logger.warn("host_collection_failed", {
          ...context, host_id: host.collection.hostId, collection_stage: host.collection.aggregates === null ? "aggregate" : "sample",
          ...failureLogContext({ ...failure, ...(httpStatus === undefined ? {} : { httpStatus }) }),
        });
      }
      dependencies.logger.info("host_analysis_completed", {
      ...context, host_id: host.collection.hostId, collection_status: host.collection.collectionStatus,
      samples_status: host.collection.samplesStatus, rule_attention: host.ruleAttention,
      coverage_status: snapshot.incident.zone.coverage.status,
      });
    }
    for (const host of ai.hosts) {
      if (host.status === "unavailable" && host.failure !== undefined) dependencies.logger.warn("host_ai_failed", { ...context, host_id: host.hostId, ...failureLogContext(host.failure) });
      dependencies.logger.info("host_ai_completed", {
      ...context, host_id: host.hostId, ai_host_status: host.status,
      ...(host.status === "unavailable" ? { error_code: host.reason } : {}),
      });
    }
    if (ai.failure !== undefined) logExternalFailure(dependencies.logger, message, ai.failure);
  } catch { /* Observation must not replay analysis or suppress notification. */ }
  let status: "sent" | "notification_failed" = "sent";
  let sending = false;
  try {
    const text = formatHostWeComMessage({ snapshot, ai }, dependencies.formatterOptions);
    sending = true;
    await dependencies.notification.send(text);
  } catch (error) {
    status = "notification_failed";
    const failure = sending ? failureLogContext(toExternalFailure(error, "wecom")) : {
      failure_source: "formatter", error_code: error instanceof AppError ? error.code : "notification_format_failed", retryable: false,
    };
    try { dependencies.logger.error("notification_failed", { ...context, ...failure, snapshot_status: snapshot.status, ...(snapshot.status === "collection_failed" ? { snapshot_error_code: snapshot.errorCode } : {}) }); }
    catch { /* Notification outcome is already final. */ }
  }
  if (status === "sent") {
    try { dependencies.logger.info("notification_sent", { ...context, cloudflare_api_status: snapshot.status, llm_api_status: ai.status, wecom_status: "sent", response_category: "success" }); }
    catch { /* Sending succeeded; logging cannot trigger replay. */ }
  }
  return { status, snapshotStatus: snapshot.status, aiStatus: ai.status };
}
import type { LocalAnalysisFailure, ValidationDiagnostics } from "../observability/ai-diagnostics";

export { processHostAlert as processAlert };

function validationLogContext(failure: ValidationDiagnostics): Record<string, unknown> {
  return {
    ...(failure.validationStage === undefined ? {} : { validation_stage: failure.validationStage }),
    ...(failure.validationReason === undefined ? {} : { validation_reason: failure.validationReason }),
    ...(failure.validationPaths === undefined ? {} : { validation_paths: failure.validationPaths }),
    ...(failure.issueCount === undefined ? {} : { issue_count: failure.issueCount }),
    ...(failure.referenceCount === undefined ? {} : { reference_count: failure.referenceCount }),
    ...(failure.catalogEntryCount === undefined ? {} : { catalog_entry_count: failure.catalogEntryCount }),
  };
}

function failureLogContext(failure: ExternalFailure | LocalAnalysisFailure): Record<string, unknown> {
  if ("failureSource" in failure) return {
    failure_source: failure.failureSource, error_code: failure.errorCode, retryable: false,
    ...validationLogContext(failure),
  };
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
    ...(failure.finishReason === undefined ? {} : { finish_reason: failure.finishReason }),
    ...(failure.refusalPresent === undefined
      ? {}
      : { refusal_present: failure.refusalPresent }),
    ...(failure.contentLength === undefined ? {} : { content_length: failure.contentLength }),
    ...(failure.completionTokens === undefined
      ? {}
      : { completion_tokens: failure.completionTokens }),
    ...(failure.reasoningTokens === undefined
      ? {}
      : { reasoning_tokens: failure.reasoningTokens }),
    ...validationLogContext(failure),
    ...(failure.schemaIssuePaths === undefined
      ? {}
      : { schema_issue_paths: failure.schemaIssuePaths }),
  };
}

function logExternalFailure(
  logger: Logger,
  message: QueueMessage,
  failure: ExternalFailure | LocalAnalysisFailure,
): void {
  try {
    logger.warn("failureSource" in failure ? "analysis_failed" : "external_api_failed", {
      incident_id: message.incidentId,
      correlation_id: message.correlationId,
      analysis_window: message.analysisWindow,
      ...failureLogContext(failure),
    });
  } catch {
    // Observability must not change the dependency failure path.
  }
}
