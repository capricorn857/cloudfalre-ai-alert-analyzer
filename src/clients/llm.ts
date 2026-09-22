import { z } from "zod";

import { validateAIAnalysisEvidence, type AIAnalysisInput } from "../analysis/evidence";
import { AIAnalysisSchema, type AIAnalysis } from "../domain/ai-analysis";
import { AppError, classifyHttpError, classifyUnknownError } from "../observability/errors";
import { workerFetch } from "./fetch";

const LLMOutputSchema = z
  .object({
    risk_level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
    attack_type: z.enum([
      "Scanning",
      "Brute Force",
      "Credential Stuffing",
      "API Abuse",
      "Bot",
      "Vulnerability Scanning",
      "Unknown",
    ]),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1).max(1000),
    evidence: z.array(z.string().min(1).max(500)).max(10),
    recommendations: z.array(z.string().min(1).max(500)).max(3),
  })
  .transform((output) =>
    AIAnalysisSchema.parse({
      riskLevel: output.risk_level,
      attackType: output.attack_type,
      confidence: output.confidence,
      summary: output.summary,
      evidence: output.evidence,
      recommendations: output.recommendations,
    }),
  );

const CompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().optional(),
        message: z.object({
          content: z.string().optional(),
          refusal: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      completion_tokens: z.number().int().nonnegative().optional(),
      reasoning_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type CompletionResponse = z.infer<typeof CompletionResponseSchema>;

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.join(".") || "root"))].slice(0, 20);
}

export interface LLMClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}

export class LLMClient {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;

  constructor(options: LLMClientOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/$/u, "")}/chat/completions`;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? workerFetch;
    this.timeoutMs = options.timeoutMs;
    this.maxOutputTokens = options.maxOutputTokens;
  }

  async analyze(input: AIAnalysisInput): Promise<AIAnalysis> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    const request = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: this.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "cloudflare_security_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["risk_level", "attack_type", "confidence", "summary", "evidence", "recommendations"],
              properties: {
                risk_level: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
                attack_type: {
                  type: "string",
                  enum: ["Scanning", "Brute Force", "Credential Stuffing", "API Abuse", "Bot", "Vulnerability Scanning", "Unknown"],
                },
                confidence: { type: "number" },
                summary: { type: "string" },
                evidence: { type: "array", items: { type: "string" } },
                recommendations: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content: "Explain only supplied facts. Do not recalculate statistics, invent evidence, or claim that changes were executed. Return JSON only.",
          },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    } satisfies RequestInit;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(this.endpoint, request);
      } catch (error) {
        throw classifyUnknownError(error, "llm", durationMs());
      }
      if (!response.ok) {
        const error = classifyHttpError("llm", response.status, durationMs());
        if (error.retryable && attempt === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw error;
      }

      let envelope: CompletionResponse;
      try {
        envelope = CompletionResponseSchema.parse(await response.json());
      } catch {
        throw new AppError("llm_response_invalid", "llm_response_invalid", false, undefined, {
          externalService: "llm",
          failureKind: "invalid_response",
          durationMs: durationMs(),
        });
      }
      const choice = envelope.choices[0];
      const content = choice?.message.content;
      const finishReason = choice?.finish_reason;
      const refusalPresent = choice?.message.refusal !== undefined && choice.message.refusal !== null;
      const usage = envelope.usage;
      const diagnostics = {
        externalService: "llm" as const,
        failureKind: "invalid_response" as const,
        durationMs: durationMs(),
        ...(finishReason === undefined ? {} : { finishReason }),
        refusalPresent,
        ...(content === undefined ? {} : { contentLength: content.length }),
        ...(usage?.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
        ...(usage?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.reasoning_tokens }),
      };
      if (finishReason === "length") {
        throw new AppError("llm_output_truncated", "llm_output_truncated", false, undefined, {
          ...diagnostics,
          validationStage: "finish_reason",
        });
      }
      if (refusalPresent) {
        throw new AppError("llm_refused", "llm_refused", false, undefined, {
          ...diagnostics,
          validationStage: "refusal",
        });
      }
      if (content === undefined) {
        throw new AppError("llm_response_invalid", "llm_response_invalid", false, undefined, diagnostics);
      }

      let unknownOutput: unknown;
      try {
        unknownOutput = JSON.parse(content) as unknown;
      } catch {
        throw new AppError("llm_output_not_json", "llm_output_not_json", false, undefined, {
          ...diagnostics,
          validationStage: "parsing",
        });
      }
      const parsed = LLMOutputSchema.safeParse(unknownOutput);
      if (!parsed.success) {
        throw new AppError("llm_output_schema_invalid", "llm_output_schema_invalid", false, undefined, {
          ...diagnostics,
          validationStage: "schema",
          schemaIssuePaths: issuePaths(parsed.error),
        });
      }
      try {
        validateAIAnalysisEvidence(parsed.data, input);
      } catch {
        throw new AppError("ai_evidence_invalid", "ai_evidence_invalid", false, undefined, {
          ...diagnostics,
          validationStage: "evidence",
        });
      }
      return parsed.data;
    }
    throw new AppError("llm_unexpected", "llm request failed", true, undefined, {
      externalService: "llm",
      failureKind: "unknown",
      durationMs: durationMs(),
    });
  }
}
