import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { z } from "zod";
import { buildEvidenceCatalog } from "../../src/analysis/evidence-catalog";
import { validateAIAnalysisEvidence } from "../../src/analysis/evidence";
import { LLMClient } from "../../src/clients/llm";
import { getCompletionDiagnostics, type CompletionDiagnostics } from "../../src/observability/ai-diagnostics";
import { toExternalFailure } from "../../src/observability/errors";
import { createLogger } from "../../src/observability/logger";
import { makeEvidenceCatalogInput } from "../fixtures/evidence-catalog";

it("supports requests that do not follow redirects", (context) => {
  expect(new Request("https://example.invalid", { redirect: "manual" }).redirect).toBe("manual");
  Object.assign(context.task.meta, { liveLlmReports: [JSON.stringify({ event: "live_runner_check", status: "passed" })] });
});

it("validates three real completions using fictional evidence", async (context) => {
  const parsed = z.object({
    LLM_BASE_URL: z.url(), LLM_MODEL: z.string().min(1), LLM_API_KEY: z.string().min(1),
  }).safeParse(env);
  if (!parsed.success) throw new Error("live_llm_config_invalid");
  const config = parsed.data;
  const endpoint = `${config.LLM_BASE_URL.replace(/\/$/u, "")}/chat/completions`;
  const meta = Object.assign(context.task.meta, { liveLlmReports: [] as string[] });
  const logger = createLogger({ secrets: [config.LLM_API_KEY, config.LLM_BASE_URL], sink: (line) => meta.liveLlmReports.push(line) });
  const reports: { status: "passed" | "failed" }[] = [];

  for (let run = 1; run <= 3; run++) {
    const catalog = buildEvidenceCatalog(makeEvidenceCatalogInput());
    const httpAttempts: { status: number; headers_ms: number }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target !== endpoint) throw new Error("live_llm_endpoint_mismatch");
      const started = Date.now();
      const response = await fetch(input, { ...init, redirect: "manual" });
      httpAttempts.push({ status: response.status, headers_ms: Date.now() - started });
      return response;
    };
    const client = new LLMClient({
      baseUrl: config.LLM_BASE_URL, model: config.LLM_MODEL, apiKey: config.LLM_API_KEY,
      timeoutMs: 30_000, maxOutputTokens: 2048, fetchFn,
    });
    const started = Date.now();
    let diagnostics: CompletionDiagnostics | undefined;
    let structureValid = false;
    try {
      const output = await client.analyze(catalog);
      diagnostics = getCompletionDiagnostics(output);
      structureValid = true;
      const validated = validateAIAnalysisEvidence(output, catalog);
      logger.info("live_llm_result", {
        run, status: "passed", duration_ms: Date.now() - started, http_attempts: httpAttempts,
        structure_valid: true, references_and_support_valid: true,
        attack_unknown: validated.analysis.attack.type === "Unknown",
        finish_reason: diagnostics?.finishReason,
        completion_tokens: diagnostics?.completionTokens,
        content_length: diagnostics?.contentLength,
      });
      reports.push({ status: "passed" });
    } catch (error) {
      const failure = toExternalFailure(error, "llm");
      logger.warn("live_llm_result", {
        run, status: "failed", duration_ms: Date.now() - started, http_attempts: httpAttempts,
        structure_valid: structureValid, references_and_support_valid: false,
        error_code: failure.errorCode, failure_kind: failure.failureKind,
        validation_stage: failure.validationStage, validation_reason: failure.validationReason,
        validation_paths: failure.validationPaths, issue_count: failure.issueCount,
        finish_reason: diagnostics?.finishReason ?? failure.finishReason,
        completion_tokens: diagnostics?.completionTokens ?? failure.completionTokens,
        content_length: diagnostics?.contentLength ?? failure.contentLength,
      });
      reports.push({ status: "failed" });
    }
  }
  const passed = reports.filter((report) => report.status === "passed").length;
  logger.info("live_llm_summary", { total: reports.length, passed, failed: reports.length - passed });
  expect(passed, "See controlled live_llm_result diagnostics").toBe(3);
});
