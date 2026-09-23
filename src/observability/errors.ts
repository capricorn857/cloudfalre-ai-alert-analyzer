import type { EvidenceFailureReason } from "../analysis/evidence";

export type ErrorStage = "input" | "config" | "cloudflare" | "llm" | "wecom" | "queue";
export type ExternalService = "cloudflare" | "llm" | "wecom";
export type FailureKind =
  | "timeout"
  | "network"
  | "dns"
  | "tls"
  | "connection"
  | "http"
  | "invalid_response"
  | "service_error"
  | "unknown";
export type ResponseCategory =
  | "transport_error"
  | "http_error"
  | "invalid_response"
  | "api_error"
  | "success";

export interface AppErrorDetails {
  readonly externalService?: ExternalService;
  readonly failureKind?: FailureKind;
  readonly durationMs?: number;
  readonly httpStatus?: number;
  readonly responseCategory?: ResponseCategory;
  readonly finishReason?: string;
  readonly refusalPresent?: boolean;
  readonly contentLength?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
  readonly validationStage?: "finish_reason" | "refusal" | "parsing" | "schema" | "evidence";
  readonly schemaIssuePaths?: readonly string[];
  readonly evidenceFailureReason?: EvidenceFailureReason;
}

export interface ExternalFailure {
  readonly externalService: ExternalService;
  readonly errorCode: string;
  readonly failureKind: FailureKind;
  readonly retryable: boolean;
  readonly durationMs: number;
  readonly httpStatus?: number;
  readonly responseCategory?: ResponseCategory;
  readonly finishReason?: string;
  readonly refusalPresent?: boolean;
  readonly contentLength?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
  readonly validationStage?: AppErrorDetails["validationStage"];
  readonly schemaIssuePaths?: readonly string[];
  readonly evidenceFailureReason?: EvidenceFailureReason;
}

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly externalService: ExternalService | undefined;
  readonly failureKind: FailureKind | undefined;
  readonly durationMs: number | undefined;
  readonly httpStatus: number | undefined;
  readonly responseCategory: ResponseCategory | undefined;
  readonly finishReason: string | undefined;
  readonly refusalPresent: boolean | undefined;
  readonly contentLength: number | undefined;
  readonly completionTokens: number | undefined;
  readonly reasoningTokens: number | undefined;
  readonly validationStage: AppErrorDetails["validationStage"];
  readonly schemaIssuePaths: readonly string[] | undefined;
  readonly evidenceFailureReason: EvidenceFailureReason | undefined;

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    status?: number,
    details: AppErrorDetails = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.externalService = details.externalService;
    this.failureKind = details.failureKind;
    this.durationMs = details.durationMs;
    this.httpStatus = details.httpStatus ?? status;
    this.responseCategory = details.responseCategory;
    this.finishReason = details.finishReason;
    this.refusalPresent = details.refusalPresent;
    this.contentLength = details.contentLength;
    this.completionTokens = details.completionTokens;
    this.reasoningTokens = details.reasoningTokens;
    this.validationStage = details.validationStage;
    this.schemaIssuePaths = details.schemaIssuePaths;
    this.evidenceFailureReason = details.evidenceFailureReason;
  }
}

function normalizedDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function runtimeCauseCode(error: TypeError): string | undefined {
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code.toUpperCase() : undefined;
}

function classifyTransportKind(error: TypeError): FailureKind {
  const code = runtimeCauseCode(error);
  if (code === undefined) return "network";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code.startsWith("DNS_")) return "dns";
  if (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("CERT_") ||
    code.includes("CERTIFICATE")
  ) {
    return "tls";
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") {
    return "connection";
  }
  return "network";
}

export function classifyHttpError(
  stage: ExternalService,
  status: number,
  durationMs = 0,
  responseCategory?: ResponseCategory,
): AppError {
  const retryable = status === 429 || status >= 500;
  return new AppError(
    `${stage}_http_${retryable ? "retryable" : "permanent"}`,
    `${stage} request failed with HTTP ${String(status)}`,
    retryable,
    status,
    {
      externalService: stage,
      failureKind: "http",
      durationMs: normalizedDuration(durationMs),
      httpStatus: status,
      ...(responseCategory === undefined ? {} : { responseCategory }),
    },
  );
}

export function classifyUnknownError(
  error: unknown,
  stage: ExternalService,
  durationMs = 0,
  responseCategory?: ResponseCategory,
): AppError {
  if (error instanceof AppError) return error;
  const safeDuration = normalizedDuration(durationMs);
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new AppError(`${stage}_timeout`, `${stage} request timed out`, true, undefined, {
      externalService: stage,
      failureKind: "timeout",
      durationMs: safeDuration,
      ...(responseCategory === undefined ? {} : { responseCategory }),
    });
  }
  if (error instanceof TypeError) {
    const failureKind = classifyTransportKind(error);
    return new AppError(`${stage}_${failureKind}`, `${stage} request failed`, true, undefined, {
      externalService: stage,
      failureKind,
      durationMs: safeDuration,
      ...(responseCategory === undefined ? {} : { responseCategory }),
    });
  }
  return new AppError(`${stage}_unexpected`, `${stage} request failed`, false, undefined, {
    externalService: stage,
    failureKind: "unknown",
    durationMs: safeDuration,
    ...(responseCategory === undefined ? {} : { responseCategory }),
  });
}

export function toExternalFailure(
  error: unknown,
  fallbackService: ExternalService,
): ExternalFailure {
  const classified =
    error instanceof AppError ? error : classifyUnknownError(error, fallbackService);
  return {
    externalService: classified.externalService ?? fallbackService,
    errorCode: classified.code,
    failureKind: classified.failureKind ?? "unknown",
    retryable: classified.retryable,
    durationMs: classified.durationMs ?? 0,
    ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
    ...(classified.responseCategory === undefined
      ? {}
      : { responseCategory: classified.responseCategory }),
    ...(classified.finishReason === undefined ? {} : { finishReason: classified.finishReason }),
    ...(classified.refusalPresent === undefined
      ? {}
      : { refusalPresent: classified.refusalPresent }),
    ...(classified.contentLength === undefined ? {} : { contentLength: classified.contentLength }),
    ...(classified.completionTokens === undefined
      ? {}
      : { completionTokens: classified.completionTokens }),
    ...(classified.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: classified.reasoningTokens }),
    ...(classified.validationStage === undefined
      ? {}
      : { validationStage: classified.validationStage }),
    ...(classified.schemaIssuePaths === undefined
      ? {}
      : { schemaIssuePaths: classified.schemaIssuePaths }),
    ...(classified.evidenceFailureReason === undefined
      ? {}
      : { evidenceFailureReason: classified.evidenceFailureReason }),
  };
}
