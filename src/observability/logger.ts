import { safeDiagnosticCount, safeDiagnosticPaths, safeDiagnosticReason, safeDiagnosticStage, safeFinishReason } from "./ai-diagnostics";

type LogContext = Record<string, unknown>;
type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly secrets?: readonly string[];
  readonly maxStringLength?: number;
}

const sensitiveKey = /authorization|token|api.?key|secret|webhook.?url|prompt|raw[_-]?output/i;
const sensitiveParameter = /^(?:authorization|token|api[_-]?key|secret|key)$/iu;
const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
const sensitiveAssignment = /\b(authorization|token|api[_-]?key|secret|key)=([^\s&]+)/giu;

function replaceSecrets(value: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (redacted, secret) => (secret.length === 0 ? redacted : redacted.replaceAll(secret, "[REDACTED]")),
    value,
  );
}

function redactSensitiveUrls(value: string): string {
  return value.replace(urlPattern, (candidate) => {
    try {
      const url = new URL(candidate);
      const parameters: string[] = [];
      url.searchParams.forEach((_value, parameter) => {
        parameters.push(parameter);
      });
      for (const parameter of parameters) {
        if (sensitiveParameter.test(parameter)) url.searchParams.set(parameter, "[REDACTED]");
      }
      return url.toString().replaceAll("%5BREDACTED%5D", "[REDACTED]");
    } catch {
      return "[REDACTED_URL]";
    }
  });
}

function sanitizeString(value: string, secrets: readonly string[], maximum: number): string {
  const redacted = redactSensitiveUrls(replaceSecrets(value, secrets)).replace(
    sensitiveAssignment,
    "$1=[REDACTED]",
  );
  return redacted.length <= maximum ? redacted : `${redacted.slice(0, maximum)}...[TRUNCATED]`;
}

function sanitize(
  value: unknown,
  key: string,
  secrets: readonly string[],
  maximum: number,
  seen: WeakSet<object>,
): unknown {
  if (["finish_reason", "finishReason"].includes(key)) return safeFinishReason(value);
  if (["validation_paths", "validationPaths", "schema_issue_paths", "schemaIssuePaths"].includes(key)) return safeDiagnosticPaths(value);
  if (["validation_reason", "validationReason"].includes(key)) return safeDiagnosticReason(value);
  if (["validation_stage", "validationStage"].includes(key)) return safeDiagnosticStage(value);
  if (["refusal_present", "refusalPresent"].includes(key)) return typeof value === "boolean" ? value : undefined;
  if (["evidence_failure_reason", "evidenceFailureReason"].includes(key)) return undefined;
  if (["completion_tokens", "reasoning_tokens", "completionTokens", "reasoningTokens", "content_length", "contentLength", "issue_count", "reference_count", "catalog_entry_count", "issueCount", "referenceCount", "catalogEntryCount"].includes(key)) return safeDiagnosticCount(value);
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return sanitizeString(value, secrets, maximum);
  }
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Error) {
    const diagnostic = value as Error & {
      readonly finishReason?: string;
      readonly refusalPresent?: boolean;
      readonly contentLength?: number;
      readonly completionTokens?: number;
      readonly reasoningTokens?: number;
      readonly validationStage?: string;
      readonly schemaIssuePaths?: readonly string[];
      readonly validationReason?: string;
      readonly validationPaths?: readonly string[];
      readonly issueCount?: number;
      readonly referenceCount?: number;
      readonly catalogEntryCount?: number;
    };
    return {
      name: "Error",
      message: "[REDACTED]",
      ...(diagnostic.finishReason === undefined ? {} : { finishReason: safeFinishReason(diagnostic.finishReason) }),
      ...(diagnostic.refusalPresent === undefined
        ? {}
        : { refusalPresent: typeof diagnostic.refusalPresent === "boolean" ? diagnostic.refusalPresent : undefined }),
      ...(diagnostic.contentLength === undefined
        ? {}
        : { contentLength: safeDiagnosticCount(diagnostic.contentLength) }),
      ...(diagnostic.completionTokens === undefined
        ? {}
        : { completionTokens: safeDiagnosticCount(diagnostic.completionTokens) }),
      ...(diagnostic.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: safeDiagnosticCount(diagnostic.reasoningTokens) }),
      ...(diagnostic.validationStage === undefined
        ? {}
        : { validationStage: safeDiagnosticStage(diagnostic.validationStage) }),
      ...(diagnostic.schemaIssuePaths === undefined
        ? {}
        : { schemaIssuePaths: safeDiagnosticPaths(diagnostic.schemaIssuePaths) }),
      validationReason: safeDiagnosticReason(diagnostic.validationReason),
      ...(diagnostic.validationPaths === undefined ? {} : { validationPaths: safeDiagnosticPaths(diagnostic.validationPaths) }),
      ...(diagnostic.issueCount === undefined ? {} : { issueCount: safeDiagnosticCount(diagnostic.issueCount) }),
      ...(diagnostic.referenceCount === undefined ? {} : { referenceCount: safeDiagnosticCount(diagnostic.referenceCount) }),
      ...(diagnostic.catalogEntryCount === undefined ? {} : { catalogEntryCount: safeDiagnosticCount(diagnostic.catalogEntryCount) }),
    };
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, "", secrets, maximum, seen));
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitize(entryValue, entryKey, secrets, maximum, seen),
    ]),
  );
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? console.log;
  const secrets = options.secrets ?? [];
  const maximum = options.maxStringLength ?? 1000;

  const write = (level: "info" | "warn" | "error", event: string, context: LogContext = {}) => {
    const sanitized = sanitize(context, "", secrets, maximum, new WeakSet());
    sink(JSON.stringify({ level, event, ...(sanitized as LogContext) }));
  };

  return {
    info: (event, context) => {
      write("info", event, context);
    },
    warn: (event, context) => {
      write("warn", event, context);
    },
    error: (event, context) => {
      write("error", event, context);
    },
  };
}
