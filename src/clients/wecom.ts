import { z } from "zod";

import { retryOperation, type RetryOptions } from "./retry";
import { AppError, classifyHttpError, classifyUnknownError } from "../observability/errors";
import { workerFetch } from "./fetch";

const WeComResponseSchema = z.object({
  errcode: z.number().int(),
  errmsg: z.string(),
});

export interface WeComClientOptions {
  readonly webhookUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly sleep?: RetryOptions["sleep"];
}

export class WeComClient {
  private readonly webhookUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions;

  constructor(options: WeComClientOptions) {
    this.webhookUrl = options.webhookUrl;
    this.fetchFn = options.fetchFn ?? workerFetch;
    this.timeoutMs = options.timeoutMs;
    this.retryOptions = {
      retries: options.retries,
      baseDelayMs: 100,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    };
  }

  async send(message: string): Promise<void> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    const body = JSON.stringify({ msgtype: "text", text: { content: message } });
    await retryOperation(async () => {
      let response: Response;
      try {
        response = await this.fetchFn(this.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw classifyUnknownError(error, "wecom", durationMs(), "transport_error");
      }
      if (!response.ok) {
        throw classifyHttpError("wecom", response.status, durationMs(), "http_error");
      }
      let parsed: z.infer<typeof WeComResponseSchema>;
      try {
        parsed = WeComResponseSchema.parse(await response.json());
      } catch {
        throw new AppError("wecom_response_invalid", "wecom_response_invalid", false, undefined, {
          externalService: "wecom",
          failureKind: "invalid_response",
          durationMs: durationMs(),
          responseCategory: "invalid_response",
        });
      }
      if (parsed.errcode !== 0) {
        throw new AppError("wecom_api_error", "wecom_api_error", false, undefined, {
          externalService: "wecom",
          failureKind: "service_error",
          durationMs: durationMs(),
          responseCategory: "api_error",
        });
      }
    }, this.retryOptions);
  }
}
