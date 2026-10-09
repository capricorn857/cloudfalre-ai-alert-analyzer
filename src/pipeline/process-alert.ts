import { ATTENTION_SCOPE } from "../domain/event-scope";
import type { HostSnapshotAnalysisResult } from "../domain/analysis-result";
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
  const context = { incident_id: message.incidentId, correlation_id: message.correlationId, analysis_window: message.analysisWindow,
    request_count: snapshot.collectionMetrics?.requestCount ?? 0, node_selection_count: snapshot.collectionMetrics?.nodeSelectionCount ?? 0 };
  if (snapshot.status === "suppressed") {
    logDecision(dependencies.logger, snapshot, context, "suppressed", false, false, "not_requested", "not_requested");
    try {
      dependencies.logger.info("alert_suppressed", {
        ...context, reason: snapshot.reason, policy_id: snapshot.discovery.policyId,
        event_scope: snapshot.discovery.eventScope, raw_total_events: snapshot.discovery.rawTotalEvents,
        attention_total_events: snapshot.discovery.zoneTotalEvents, blocked_total_events: snapshot.discovery.blockedTotalEvents,
        count_quality: snapshot.discovery.countQuality, comparison_status: snapshot.quality.reasonCodes.includes("raw_action_sum_mismatch") ? "estimated_difference" : "comparable",
        observation_basis: "adaptive_aggregate", sampling_limitation: "rare_events_may_be_unobserved",
        wecom_status: "not_requested", llm_api_status: "not_requested",
      });
    } catch { /* A business terminal result must survive observability failures. */ }
    return { status: "suppressed" as const, snapshotStatus: snapshot.status, aiStatus: "not_requested" as const };
  }
  const initialDecision = !("incident" in snapshot) || snapshot.status === "empty" ? "basic_exception"
    : snapshot.status === "partial" ? "partial_degradation" : "continue_analysis";
  logDecision(dependencies.logger, snapshot, context, initialDecision, false, false, "not_requested", "not_requested", "before_external_calls");
  const callState = { aiCalled: false };
  const ai = await runHostAIAnalysis(snapshot, { analyzeHosts: (catalog) => {
    callState.aiCalled = true;
    return dependencies.ai.analyzeHosts(catalog);
  } });
  try {
    if (snapshot.status === "suppression_ineligible") dependencies.logger.warn("suppression_ineligible", { ...context, reason: snapshot.reason });
    else if (snapshot.status === "collection_failed") logExternalFailure(dependencies.logger, message, snapshot.failure);
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
  const finalDecision = !("incident" in snapshot) || snapshot.status === "empty" ? "basic_exception"
    : snapshot.status === "partial" || ai.status !== "available" || status !== "sent" ? "partial_degradation" : "continue_analysis";
  logDecision(dependencies.logger, snapshot, context, finalDecision, callState.aiCalled, sending, callState.aiCalled ? ai.status : "not_requested", sending ? status : "not_requested");
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

/** Only bounded categories and validated counts enter decision diagnostics. */
function logDecision(
  logger: Logger, snapshot: HostSnapshotAnalysisResult, context: Record<string, unknown>,
  finalDecision: "suppressed" | "continue_analysis" | "partial_degradation" | "basic_exception",
  aiCalled: boolean, wecomCalled: boolean, aiStatus: string, wecomStatus: string,
  phase: "before_external_calls" | "terminal" = "terminal",
): void {
  try {
    const discovery = "discovery" in snapshot ? snapshot.discovery : null;
    const quality = "quality" in snapshot ? snapshot.quality : null;
    const known = new Set(["block", "allow", "challenge", "managed_challenge", "js_challenge", "log", "skip", "bypass"]);
    const counts = new Map<string, number>();
    for (const item of discovery?.rawActions ?? []) {
      const category = item.action === null || item.action === "" ? "unknown" : known.has(item.action) ? item.action : "other_non_block";
      counts.set(category, (counts.get(category) ?? 0) + item.count);
    }
    const hostComparisons = "incident" in snapshot ? snapshot.incident.hosts.map((host) => ({
      host_id: host.collection.hostId, discovery_count: host.collection.discoveryCount, host_total_events: host.collection.hostTotalEvents,
      reason_codes: [...host.quality.reasons, ...(host.collection.hostTotalEvents !== null && host.collection.discoveryCount !== host.collection.hostTotalEvents ? ["host_discovery_count_mismatch"] : [])],
      discovery_matches: host.collection.hostTotalEvents === null ? null : host.collection.discoveryCount === host.collection.hostTotalEvents,
      invalid_ratios: [
        ...(host.statistics?.zoneShare == null ? ["zone_share"] : []),
        ...(!host.quality.actionsComplete ? ["action_ratios"] : []),
        ...(!host.quality.sourcesComplete ? ["source_ratios"] : []),
        ...(host.statistics === null ? ["host_ratios"] : [
          ...(host.statistics.topIp === null ? ["ip_ratio"] : []),
          ...(host.statistics.topPath === null ? ["path_ratio"] : []),
          ...(host.statistics.topCountry === null ? ["country_ratio"] : []),
          ...(host.statistics.topAsn === null ? ["asn_ratio"] : []),
          ...(host.statistics.userAgentConcentration === null ? ["sample_ua_ratio"] : []),
        ]),
      ],
    })) : [];
    logger.info(phase === "terminal" ? "alert_decision" : "analysis_decision", {
      ...context, policy_id: ATTENTION_SCOPE.policyId, event_scope: ATTENTION_SCOPE.eventScope,
      decision_version: "aggregate-quality-v2",
      ...(phase === "terminal" ? { final_decision: finalDecision } : { decision: finalDecision, decision_phase: phase }),
      reason_codes: quality?.reasonCodes ?? (snapshot.status === "collection_failed" ? [snapshot.errorCode] : []),
      raw_total_events: discovery?.rawTotalEvents ?? null, attention_total_events: discovery?.zoneTotalEvents ?? null,
      blocked_total_events: discovery?.blockedTotalEvents ?? null, raw_action_count_sum: quality?.rawActionCountSum ?? null,
      known_non_block_count_sum: quality?.knownNonBlockCountSum ?? null,
      action_counts: discovery === null ? null : [...counts].map(([category, count]) => ({ category, count })),
      action_distribution_truncated: quality?.actionDistributionTruncated ?? null, unknown_action_count: quality?.unknownActionCount ?? null,
      filtered_top_host_count: quality?.filteredTopHostCount ?? null, filtered_top_host_count_sum: quality?.filteredTopHostCountSum ?? null,
      comparisons: quality?.comparisons ?? [], invalid_ratios: [...new Set([
        ...(quality?.invalidRatios ?? ["zone_share", "coverage"]),
        ...("incident" in snapshot && snapshot.incident.zone.coverage.ratio === null ? ["coverage"] : []),
      ])],
      host_comparisons: hostComparisons, count_quality: discovery?.countQuality ?? null,
      observation_basis: "adaptive_aggregate", sampling_limitation: "rare_events_may_be_unobserved",
      ai_called: aiCalled, wecom_called: wecomCalled, llm_api_status: aiStatus, wecom_status: wecomStatus,
    });
  } catch { /* Diagnostics never change a completed business outcome. */ }
}
