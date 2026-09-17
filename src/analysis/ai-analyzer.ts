import type { AIAnalysisClient } from "../clients/contracts";
import { AIAnalysisSchema, type AIAnalysis, type AIUnavailable } from "../domain/ai-analysis";
import type { SnapshotAnalysisResult } from "../domain/analysis-result";
import { toExternalFailure, type ExternalFailure } from "../observability/errors";

export type AIAnalysisResult =
  | { readonly status: "available"; readonly analysis: AIAnalysis }
  | (AIUnavailable & { readonly failure?: ExternalFailure });

export async function runAIAnalysis(
  snapshot: SnapshotAnalysisResult,
  client: AIAnalysisClient,
): Promise<AIAnalysisResult> {
  if (snapshot.status !== "success") {
    return {
      status: "unavailable",
      reason:
        snapshot.status === "empty"
          ? "Insufficient Security Events data"
          : "Cloudflare data unavailable",
    };
  }

  try {
    const analysis = AIAnalysisSchema.parse(
      await client.analyze({
        incident: snapshot.incident,
        statistics: snapshot.statistics,
        findings: snapshot.findings,
      }),
    );
    return { status: "available", analysis };
  } catch (error) {
    return {
      status: "unavailable",
      reason: "AI analysis unavailable",
      failure: toExternalFailure(error, "llm"),
    };
  }
}
