import { AppError } from "./errors";

export const validationReasons = [
  "invalid_json", "invalid_shape", "unknown_field", "limit_exceeded",
  "duplicate_reference", "duplicate_claim", "duplicate_recommendation", "reference_not_found",
  "reference_type_mismatch", "missing_support", "unrelated_reference", "support_condition_failed",
  "unsupported_claim_type", "invalid_unknown", "insufficient_data", "invalid_catalog",
  "inconsistent_source", "catalog_budget_exceeded",
] as const;
export type ValidationReason = (typeof validationReasons)[number];
export type ValidationStage = "finish_reason" | "refusal" | "parsing" | "schema" | "reference" | "support" | "catalog";
export interface ValidationDiagnostics {
  readonly validationStage?: ValidationStage;
  readonly validationReason?: ValidationReason;
  readonly validationPaths?: readonly string[];
  readonly issueCount?: number;
  readonly referenceCount?: number;
  readonly catalogEntryCount?: number;
}

const paths = new Set([
  "root", "schema_version", "risk", "risk.level", "risk.evidence_ids", "attack", "attack.type",
  "attack.confidence", "attack.evidence_ids", "observations", "observations[].kind",
  "observations[].dimension", "observations[].evidence_ids", "recommendations",
  "recommendations[].kind", "recommendations[].evidence_ids",
]);

export function safeValidationPaths(issues: readonly (readonly PropertyKey[])[]): string[] {
  return [...new Set(issues.slice(0, 100).map((parts) => {
    let path = "";
    for (const part of parts) {
      if (typeof part === "number") {
        if (path === "observations" || path === "recommendations") path += "[]";
      } else if (typeof part === "string") {
        const field = part === "evidenceIds" ? "evidence_ids" : part === "schemaVersion" ? "schema_version" : part;
        path += `${path === "" ? "" : "."}${field}`;
      } else return "root";
    }
    return paths.has(path) ? path : "root";
  }))].slice(0, 10);
}

export function safeDiagnosticPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return ["root"];
  return [...new Set(value.slice(0, 10).map((path: unknown) => typeof path === "string" && paths.has(path) ? path : "root"))];
}

export function safeFinishReason(value: unknown): string {
  return typeof value === "string" && ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(value) ? value : "unknown";
}

export function safeDiagnosticCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(65535, Math.max(0, Math.floor(value))) : 0;
}

export function safeDiagnosticReason(value: unknown): ValidationReason | undefined {
  return validationReasons.find((reason) => reason === value);
}

export function safeDiagnosticStage(value: unknown): ValidationStage | undefined {
  const stages: readonly ValidationStage[] = ["finish_reason", "refusal", "parsing", "schema", "reference", "support", "catalog"];
  return stages.find((stage) => stage === value);
}

export function validationError(
  code: string,
  stage: ValidationStage,
  reason: ValidationReason,
  path = "root",
  counts: Pick<ValidationDiagnostics, "referenceCount" | "catalogEntryCount" | "issueCount"> = {},
): AppError {
  return new AppError(code, code, false, undefined, {
    ...(stage === "catalog" ? {} : { externalService: "llm" as const }),
    failureKind: "invalid_response", validationStage: stage, validationReason: reason,
    validationPaths: safeDiagnosticPaths([path]), issueCount: 1, ...counts,
  });
}

export interface LocalAnalysisFailure extends ValidationDiagnostics {
  readonly failureSource: "catalog";
  readonly errorCode: "ai_catalog_invalid";
  readonly retryable: false;
}

export interface CompletionDiagnostics {
  readonly durationMs: number;
  readonly finishReason?: string;
  readonly refusalPresent?: boolean;
  readonly contentLength?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

// Transport metadata follows the result without becoming part of the model contract.
const completionDiagnostics = new WeakMap<object, CompletionDiagnostics>();

export function rememberCompletionDiagnostics(result: object, diagnostics: CompletionDiagnostics): void {
  completionDiagnostics.set(result, {
    durationMs: Number.isFinite(diagnostics.durationMs) ? Math.max(0, diagnostics.durationMs) : 0,
    ...(diagnostics.finishReason === undefined ? {} : { finishReason: safeFinishReason(diagnostics.finishReason) }),
    ...(typeof diagnostics.refusalPresent !== "boolean" ? {} : { refusalPresent: diagnostics.refusalPresent }),
    ...(diagnostics.contentLength === undefined ? {} : { contentLength: safeDiagnosticCount(diagnostics.contentLength) }),
    ...(diagnostics.completionTokens === undefined ? {} : { completionTokens: safeDiagnosticCount(diagnostics.completionTokens) }),
    ...(diagnostics.reasoningTokens === undefined ? {} : { reasoningTokens: safeDiagnosticCount(diagnostics.reasoningTokens) }),
  });
}

export function getCompletionDiagnostics(result: object): CompletionDiagnostics | undefined {
  return completionDiagnostics.get(result);
}
