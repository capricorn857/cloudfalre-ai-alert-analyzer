import { z } from "zod";

import { AIAnalysisWireSchema, toAIAnalysis, type AIAnalysis } from "../domain/ai-analysis";
import { EvidenceCatalogSchema, type EvidenceCatalog } from "../domain/evidence-catalog";
import { rememberCompletionDiagnostics, safeFinishReason, safeValidationPaths, type ValidationReason } from "../observability/ai-diagnostics";
import { AppError, classifyHttpError, classifyUnknownError } from "../observability/errors";
import { workerFetch } from "./fetch";

const CompletionResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().optional(),
    message: z.object({ content: z.string().optional(), refusal: z.string().nullable().optional() }),
  })).min(1),
  usage: z.object({
    completion_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});
type CompletionResponse = z.infer<typeof CompletionResponseSchema>;

function schemaValidationReason(error: z.ZodError): ValidationReason {
  if (error.issues.some((issue) => issue.code === "unrecognized_keys")) return "unknown_field";
  if (error.issues.some((issue) => issue.code === "too_big" || issue.code === "too_small")) return "limit_exceeded";
  return "invalid_shape";
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

  async analyze(input: EvidenceCatalog): Promise<AIAnalysis> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    const parsedCatalog = EvidenceCatalogSchema.safeParse(input);
    if (!parsedCatalog.success) {
      throw new AppError("ai_catalog_invalid", "ai_catalog_invalid", false, undefined, {
        failureKind: "invalid_response",
        validationStage: "catalog",
        validationReason: "invalid_catalog",
        validationPaths: ["root"],
        issueCount: parsedCatalog.error.issues.length,
      });
    }

    const request = {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        max_completion_tokens: this.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "cloudflare_security_analysis",
            strict: true,
            schema: z.toJSONSchema(AIAnalysisWireSchema),
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Analyze only the supplied Evidence Catalog. Do not query Cloudflare, recalculate statistics, invent facts, repeat entity values, add free text, or claim an action was executed.\n" +
              "Each risk, attack, observation, and recommendation must cite its own evidence_ids. Use only catalog IDs and exactly the roles below; do not add unrelated evidence. Do not infer relationships between aggregate entries. Samples support only one observed event and never aggregate proportions.\n" +
              "Risk rules:\n" +
              "- HIGH or MEDIUM risk: quality + one highest-level risk finding + its stat. The level must equal the highest level among ip/path/country/asn/allow/request_rate findings; quality must be riskAssessable.\n" +
              "- LOW risk: quality + total, only when the risk finding set is empty and quality is riskAssessable. LOW does not mean safe.\n" +
              "- CRITICAL risk is unsupported. Unknown risk uses no evidence.\n" +
              "Attack rules:\n" +
              "- Bot attack only: stat_ua + high UA finding + stat_rate + high rate finding; quality must be riskAssessable, UA denominator >= 10 and confidence > 0 and <= 0.6.\n" +
              "- All other non-Unknown attack types are unsupported. Unknown attack uses confidence 0 and no evidence.\n" +
              "Observation rules:\n" +
              "- aggregate_concentration: matching stat + matching medium/high finding + total, dimension ip/path/country/asn.\n" +
              "- action_ratio allow/block: matching stat + matching medium/high finding + total. action_ratio challenge: stat_challenge + total.\n" +
              "- request_rate: stat_rate + medium/high request_rate finding + context.\n" +
              "- sample_ua_concentration: stat_ua + medium/high UA finding. sample_observed: exactly one sample.\n" +
              "- insufficient_data with dimension none uses no evidence when dataSufficient or riskAssessable is false, or there is no supported attack hypothesis under the Bot rules above.\n" +
              "Recommendation rules:\n" +
              "- review_source: exactly one nonzero aggregate IP, country, or ASN. review_target: exactly one nonzero aggregate path or host.\n" +
              "- review_waf: stat_allow + medium/high allow finding + total. verify_sample: exactly one sample or stat_ua. manual_dashboard: context.\n" +
              "Return exactly one JSON object matching the supplied schema, with no Markdown or extra fields.",
          },
          { role: "user", content: JSON.stringify(parsedCatalog.data) },
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
          externalService: "llm", failureKind: "invalid_response", durationMs: durationMs(),
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
        ...(finishReason === undefined ? {} : { finishReason: safeFinishReason(finishReason) }),
        refusalPresent,
        ...(content === undefined ? {} : { contentLength: content.length }),
        ...(usage?.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
        ...(usage?.reasoning_tokens === undefined ? {} : { reasoningTokens: usage.reasoning_tokens }),
      };
      if (finishReason === "length") {
        throw new AppError("llm_output_truncated", "llm_output_truncated", false, undefined, {
          ...diagnostics, validationStage: "finish_reason",
        });
      }
      if (refusalPresent) {
        throw new AppError("llm_refused", "llm_refused", false, undefined, {
          ...diagnostics, validationStage: "refusal",
        });
      }
      if (content === undefined) {
        throw new AppError("llm_response_invalid", "llm_response_invalid", false, undefined, diagnostics);
      }

      let output: unknown;
      try {
        output = JSON.parse(content) as unknown;
      } catch {
        throw new AppError("llm_output_not_json", "llm_output_not_json", false, undefined, {
          ...diagnostics, validationStage: "parsing", validationReason: "invalid_json",
          validationPaths: ["root"], issueCount: 1,
        });
      }
      const parsed = AIAnalysisWireSchema.safeParse(output);
      if (!parsed.success) {
        throw new AppError("llm_output_schema_invalid", "llm_output_schema_invalid", false, undefined, {
          ...diagnostics,
          validationStage: "schema",
          validationReason: schemaValidationReason(parsed.error),
          validationPaths: safeValidationPaths(parsed.error.issues.map((issue) => issue.path)),
          issueCount: parsed.error.issues.length,
        });
      }
      const analysis = toAIAnalysis(parsed.data);
      rememberCompletionDiagnostics(analysis, diagnostics);
      return analysis;
    }
    throw new AppError("llm_unexpected", "llm request failed", true, undefined, {
      externalService: "llm", failureKind: "unknown", durationMs: durationMs(),
    });
  }
}
