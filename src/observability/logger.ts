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
    };
    return {
      name: sanitizeString(value.name, secrets, maximum),
      message: sanitize(value.message, "message", secrets, maximum, seen),
      ...(diagnostic.finishReason === undefined ? {} : { finishReason: diagnostic.finishReason }),
      ...(diagnostic.refusalPresent === undefined
        ? {}
        : { refusalPresent: diagnostic.refusalPresent }),
      ...(diagnostic.contentLength === undefined
        ? {}
        : { contentLength: diagnostic.contentLength }),
      ...(diagnostic.completionTokens === undefined
        ? {}
        : { completionTokens: diagnostic.completionTokens }),
      ...(diagnostic.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: diagnostic.reasoningTokens }),
      ...(diagnostic.validationStage === undefined
        ? {}
        : { validationStage: diagnostic.validationStage }),
      ...(diagnostic.schemaIssuePaths === undefined
        ? {}
        : { schemaIssuePaths: diagnostic.schemaIssuePaths.slice(0, 20) }),
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
