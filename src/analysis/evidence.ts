import type { AIAnalysis } from "../domain/ai-analysis";
import type { Finding } from "../domain/finding";
import type { Incident } from "../domain/incident";
import type { Statistics } from "../domain/statistics";
import { AppError } from "../observability/errors";

export interface AIAnalysisInput {
  readonly incident: Incident;
  readonly statistics: Statistics;
  readonly findings: Finding[];
}

const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const pathPattern = /\/[A-Za-z0-9_/?=&%-]+/gu;
const asnPattern = /\bAS\d+\b/gu;
const automaticActionPattern =
  /\b(blocked|banned|modified|updated|changed)\b.{0,40}\b(automatically|successfully|already)\b|\b(automatically|successfully|already)\b.{0,40}\b(blocked|banned|modified|updated|changed)\b|已.{0,20}(封禁|修改)/iu;

function values(input: AIAnalysisInput): Set<string> {
  const evidence = input.incident.evidence;
  return new Set([
    ...evidence.topIps.map((item) => item.value),
    ...evidence.topPaths.map((item) => item.value),
    ...evidence.topHosts.map((item) => item.value),
    ...evidence.topCountries.map((item) => item.value),
    ...evidence.topAsns.map((item) => item.value),
    ...input.incident.samples.flatMap((sample) => [
      sample.clientIP,
      sample.clientRequestPath ?? "",
      sample.clientAsn === null ? "" : `AS${sample.clientAsn.replace(/^AS/u, "")}`,
    ]),
  ]);
}

function extractedEntities(text: string): string[] {
  return [
    ...(text.match(ipv4Pattern) ?? []),
    ...(text.match(pathPattern) ?? []),
    ...(text.match(asnPattern) ?? []),
  ];
}

export function validateAIAnalysisEvidence(
  analysis: AIAnalysis,
  input: AIAnalysisInput,
): void {
  const permitted = values(input);
  const text = [
    analysis.summary,
    ...analysis.evidence,
    ...analysis.recommendations,
  ].join("\n");
  const unsupported = extractedEntities(text).filter((entity) => !permitted.has(entity));
  const insufficient =
    !input.statistics.dataSufficient ||
    (input.findings.length > 0 && input.findings.every((finding) => finding.level === "unknown"));

  if (
    unsupported.length > 0 ||
    automaticActionPattern.test(text) ||
    (insufficient && analysis.attackType !== "Unknown")
  ) {
    throw new AppError("ai_evidence_invalid", "ai_evidence_invalid", false);
  }
}
