import { describe, expect, it } from "vitest";
import { createLogger } from "../../../src/observability/logger";
import { AppError, toExternalFailure } from "../../../src/observability/errors";
import { safeValidationPaths, validationError } from "../../../src/observability/ai-diagnostics";

describe("AI diagnostics", () => {
  it("maps arbitrary issue paths into a bounded allowlist", () => {
    expect(safeValidationPaths([["observations", 2, "evidence_ids", 0], ["ENTITY_SENTINEL"], ["risk", "level"]]))
      .toEqual(["observations[].evidence_ids", "root", "risk.level"]);
  });
  it("projects stable errors without storing raw issue values", () => {
    const error = validationError("ai_reference_invalid", "reference", "reference_not_found", "attack.evidence_ids", { referenceCount: 2, catalogEntryCount: 10 });
    expect(error).toMatchObject({ code: "ai_reference_invalid", retryable: false, validationReason: "reference_not_found" });
    expect(toExternalFailure(error, "llm")).toMatchObject({ validationPaths: ["attack.evidence_ids"], referenceCount: 2 });
  });
  it("sanitizes diagnostic fields even from arbitrary nested error objects", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (line) => lines.push(line) });
    const error = new AppError("llm_output_schema_invalid", "safe", false);
    Object.assign(error, { finishReason: "FINISH_SENTINEL", validationPaths: ["PATH_SENTINEL"], validationReason: "REASON_SENTINEL", schemaIssuePaths: ["OLD_PATH_SENTINEL"], referenceCount: "COUNT_SENTINEL", contentLength: "LENGTH_SENTINEL", completionTokens: "TOKENS_SENTINEL", refusalPresent: "REFUSAL_SENTINEL" });
    logger.warn("test", { error, finish_reason: "FINISH_SENTINEL", validation_paths: ["PATH_SENTINEL"], validation_reason: "REASON_SENTINEL", issue_count: "COUNT_SENTINEL" });
    expect(lines.join("\n")).not.toContain("SENTINEL");
    expect(lines.join("\n")).toContain("unknown");
  });
  it("maps internal Schema paths into the same wire allowlist", () => {
    expect(safeValidationPaths([["risk", "evidenceIds", 0], ["schemaVersion"]])).toEqual(["risk.evidence_ids", "schema_version"]);
  });
  it("never logs arbitrary Error names, messages, or causes", () => {
    const lines: string[] = [];
    const error = new Error("ENTITY_SENTINEL /private-sentinel", { cause: "CAUSE_SENTINEL" });
    error.name = "NAME_SENTINEL";
    createLogger({ sink: (line) => lines.push(line) }).warn("test", { error });
    expect(lines.join("\n")).not.toContain("SENTINEL");
    expect(lines.join("\n")).not.toContain("/private-sentinel");
  });
});
