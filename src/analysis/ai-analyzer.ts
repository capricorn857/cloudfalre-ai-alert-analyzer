import type { AIAnalysisClient } from "../clients/contracts";
import type { AIUnavailable } from "../domain/ai-analysis";
import { buildEvidenceCatalog } from "./evidence-catalog";
import { validateAIAnalysisEvidence, type ValidatedAIAnalysis } from "./evidence";
import { getCompletionDiagnostics, type CompletionDiagnostics, type LocalAnalysisFailure, validationError } from "../observability/ai-diagnostics";
import type { EvidenceCatalog } from "../domain/evidence-catalog";
import type { SnapshotAnalysisResult } from "../domain/analysis-result";
import { AppError, toExternalFailure, type ExternalFailure } from "../observability/errors";

export type AIAnalysisResult =
  | { readonly status: "available"; readonly analysis: ValidatedAIAnalysis }
  | (AIUnavailable & { readonly failure?: ExternalFailure | LocalAnalysisFailure });

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

  let catalog: EvidenceCatalog;
  try {
    catalog = buildEvidenceCatalog({ incident: snapshot.incident, statistics: snapshot.statistics, findings: snapshot.findings });
  } catch (error) {
    const classified = error instanceof AppError ? error : validationError("ai_catalog_invalid", "catalog", "invalid_catalog");
    return { status: "unavailable", reason: "AI analysis unavailable", failure: {
      failureSource: "catalog", errorCode: "ai_catalog_invalid", retryable: false,
      validationStage: "catalog", validationReason: classified.validationReason ?? "invalid_catalog",
      validationPaths: classified.validationPaths ?? ["root"], issueCount: classified.issueCount ?? 1,
    } };
  }
  let diagnostics: CompletionDiagnostics | undefined;
  try {
    const output = await client.analyze(structuredClone(catalog));
    diagnostics = getCompletionDiagnostics(output);
    const analysis = validateAIAnalysisEvidence(output, catalog);
    return { status: "available", analysis };
  } catch (error) {
    return {
      status: "unavailable",
      reason: "AI analysis unavailable",
      failure: { ...toExternalFailure(error, "llm"), ...diagnostics },
    };
  }
}
