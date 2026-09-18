import { z } from "zod";

import { RulesConfigSchema } from "./rules";

export const BusinessConfigSchema = z.object({
  beforeMinutes: z.number().int().min(1).max(1440).default(30),
  settleSeconds: z.number().int().min(0).max(900).default(60),
  sampleLimit: z.number().int().min(1).max(100).default(50),
  requestTimeoutMs: z.number().int().min(100).max(30_000),
  llmTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  retryCount: z.number().int().min(1).max(2),
  displayTimeZone: z.string().min(1),
  rules: RulesConfigSchema,
});

const BusinessConfigInputSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, BusinessConfigSchema);

const EnvSchema = z.object({
  ALERT_QUEUE: z.custom<Queue>((value) => {
    return typeof value === "object" && value !== null && "send" in value;
  }),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  WECOM_WEBHOOK_URL: z.url(),
  LLM_BASE_URL: z.url(),
  LLM_MODEL: z.string().min(1),
  BUSINESS_CONFIG: BusinessConfigInputSchema,
});

export interface RuntimeConfig {
  readonly alertQueue: Queue;
  readonly cloudflareApiToken: string;
  readonly llmApiKey: string;
  readonly wecomWebhookUrl: string;
  readonly llmBaseUrl: string;
  readonly llmModel: string;
  readonly business: Readonly<z.infer<typeof BusinessConfigSchema>>;
}

export function parseEnv(input: unknown): RuntimeConfig {
  const parsed = EnvSchema.safeParse(input);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "env"))];
    throw new Error(`Invalid configuration: ${keys.join(", ")}`);
  }

  return {
    alertQueue: parsed.data.ALERT_QUEUE,
    cloudflareApiToken: parsed.data.CLOUDFLARE_API_TOKEN,
    llmApiKey: parsed.data.LLM_API_KEY,
    wecomWebhookUrl: parsed.data.WECOM_WEBHOOK_URL,
    llmBaseUrl: parsed.data.LLM_BASE_URL,
    llmModel: parsed.data.LLM_MODEL,
    business: Object.freeze(parsed.data.BUSINESS_CONFIG),
  };
}

export type BusinessConfig = z.infer<typeof BusinessConfigSchema>;
