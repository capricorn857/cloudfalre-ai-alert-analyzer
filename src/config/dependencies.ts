import { CloudflareGraphQLClient } from "../clients/cloudflare-graphql";
import { LLMClient } from "../clients/llm";
import { WeComClient } from "../clients/wecom";
import type { ProcessAlertDependencies } from "../pipeline/process-alert";
import { createLogger } from "../observability/logger";
import type { RuntimeConfig } from "./env";

export function createProcessAlertDependencies(config: RuntimeConfig): ProcessAlertDependencies {
  return {
    cloudflare: new CloudflareGraphQLClient({
      token: config.cloudflareApiToken,
      timeoutMs: config.business.requestTimeoutMs,
      retries: config.business.retryCount,
    }),
    ai: new LLMClient({
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      apiKey: config.llmApiKey,
      timeoutMs: config.business.requestTimeoutMs,
      maxOutputTokens: 800,
    }),
    notification: new WeComClient({
      webhookUrl: config.wecomWebhookUrl,
      timeoutMs: config.business.requestTimeoutMs,
      retries: config.business.retryCount,
    }),
    logger: createLogger({
      secrets: [config.cloudflareApiToken, config.llmApiKey, config.wecomWebhookUrl],
    }),
    rulesConfig: config.business.rules,
    formatterOptions: {
      timeZone: config.business.displayTimeZone,
      maxLength: 3500,
      topLimit: 5,
    },
  };
}
