import { getCompletionDiagnostics, type LocalAnalysisFailure, validationError } from "../observability/ai-diagnostics";
import { AppError, toExternalFailure, type ExternalFailure } from "../observability/errors";
import type { HostSnapshotAnalysisResult } from "../domain/analysis-result";
import type { HostAIAnalysisClient } from "../clients/contracts";
import { buildHostEvidenceCatalog, validateHostAIAnalysis, type ValidatedHostAIAnalysis } from "./host-evidence";
import type { HostEvidenceCatalog } from "../domain/host-evidence";

export { runHostAIAnalysis as runAIAnalysis };

export type HostAIResult = { hostId: string; status: "available"; analysis: ValidatedHostAIAnalysis }
  | { hostId: string; status: "unavailable"; reason: string; failure?: ExternalFailure | LocalAnalysisFailure };
export interface HostAIAnalysisResult {
  status: "available" | "partial" | "unavailable";
  hosts: HostAIResult[];
  catalog?: HostEvidenceCatalog;
  failure?: ExternalFailure | LocalAnalysisFailure;
}

export async function runHostAIAnalysis(snapshot: HostSnapshotAnalysisResult, client: HostAIAnalysisClient): Promise<HostAIAnalysisResult> {
  if (!("incident" in snapshot)) return { status: "unavailable", hosts: [] };
  const ids = snapshot.incident.hosts.map((host) => host.collection.hostId);
  const unavailable = (reason: string): HostAIResult[] => ids.map((hostId) => ({ hostId, status: "unavailable", reason }));
  let catalog: HostEvidenceCatalog;
  try {
    catalog = buildHostEvidenceCatalog({ message: snapshot.message, zoneTotalEvents: snapshot.incident.zone.zoneTotalEvents, hosts: snapshot.incident.hosts, zoneDenominatorComparable: snapshot.incident.zone.discoveryQuality?.zoneDenominatorComparable ?? true });
  } catch { return { status: "unavailable", hosts: unavailable("ai_catalog_invalid"), failure: { failureSource: "catalog", errorCode: "ai_catalog_invalid", retryable: false, validationStage: "catalog", validationReason: "invalid_catalog", validationPaths: ["root"] } }; }
  if (catalog.hostIds.length === 0) return { status: "unavailable", hosts: unavailable("ai_data_insufficient"), catalog };
  try {
    const response = await client.analyzeHosts(structuredClone(catalog));
    const diagnostics = getCompletionDiagnostics(response);
    const identities = response.hosts.map((host) => host.hostId);
    if (new Set(identities).size !== identities.length || identities.some((id) => !catalog.hostIds.includes(id))) throw new AppError("llm_output_schema_invalid", "invalid host identity", false);
    const hosts: HostAIResult[] = ids.map((hostId) => {
      if (catalog.unavailableHosts.includes(hostId)) return { hostId, status: "unavailable", reason: "ai_catalog_invalid" };
      if (!catalog.hostIds.includes(hostId)) return { hostId, status: "unavailable", reason: "ai_data_insufficient" };
      const item = response.hosts.find((host) => host.hostId === hostId);
      if (item === undefined) return { hostId, status: "unavailable", reason: "ai_host_missing" };
      if (item.status === "invalid") return { hostId, status: "unavailable", reason: "llm_output_schema_invalid", failure: { ...toExternalFailure(validationError("llm_output_schema_invalid", "schema", "invalid_shape", "hosts"), "llm"), ...diagnostics } };
      try {
        const analysis = validateHostAIAnalysis(item.analysis, catalog);
        if (analysis.hostId !== hostId) throw new AppError("ai_reference_invalid", "host mismatch", false);
        return { hostId, status: "available", analysis };
      } catch (error) {
        const classified = error instanceof AppError ? error : validationError("ai_claim_unsupported", "support", "support_condition_failed");
        return { hostId, status: "unavailable", reason: classified.code, failure: { ...toExternalFailure(classified, "llm"), ...diagnostics } };
      }
    });
    const available = hosts.filter((host) => host.status === "available").length;
    return { status: available === hosts.length ? "available" : available > 0 ? "partial" : "unavailable", hosts, catalog };
  } catch (error) {
    return { status: "unavailable", hosts: unavailable("llm_unavailable"), catalog, failure: toExternalFailure(error, "llm") };
  }
}
