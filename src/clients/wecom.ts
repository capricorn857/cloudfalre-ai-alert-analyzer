import { z } from "zod";

import { retryOperation, type RetryOptions } from "./retry";
import { AppError, classifyHttpError, classifyUnknownError } from "../observability/errors";

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
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.retryOptions = {
      retries: options.retries,
      baseDelayMs: 100,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    };
  }

  async send(message: string): Promise<void> {
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
        throw classifyUnknownError(error, "wecom");
      }
      if (!response.ok) throw classifyHttpError("wecom", response.status);
      let parsed: z.infer<typeof WeComResponseSchema>;
      try {
        parsed = WeComResponseSchema.parse(await response.json());
      } catch {
        throw new AppError("wecom_response_invalid", "wecom_response_invalid", false);
      }
      if (parsed.errcode !== 0) {
        throw new AppError("wecom_api_error", "wecom_api_error", false);
      }
    }, this.retryOptions);
  }
}
