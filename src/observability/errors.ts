export type ErrorStage = "input" | "config" | "cloudflare" | "llm" | "wecom" | "queue";

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(code: string, message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export function classifyHttpError(stage: ErrorStage, status: number): AppError {
  const retryable = status === 429 || status >= 500;
  return new AppError(
    `${stage}_http_${retryable ? "retryable" : "permanent"}`,
    `${stage} request failed with HTTP ${String(status)}`,
    retryable,
    status,
  );
}

export function classifyUnknownError(error: unknown, stage: ErrorStage): AppError {
  if (error instanceof AppError) return error;
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new AppError(`${stage}_timeout`, `${stage} request timed out`, true);
  }
  return new AppError(`${stage}_unexpected`, `${stage} request failed`, false);
}
