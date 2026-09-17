import { describe, expect, it } from "vitest";

import { formatWeComMessage } from "../../../src/notification/formatter";
import { runAIAnalysis, type AIAnalysisResult } from "../../../src/analysis/ai-analyzer";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";

const analysis: AIAnalysis = {
  riskLevel: "HIGH",
  attackType: "Brute Force",
  confidence: 0.82,
  summary: "Traffic is concentrated on /api/login from 192.0.2.10.",
  evidence: ["192.0.2.10 = 55%", "/api/login = 45%"],
  recommendations: ["Verify the source IP.", "Review rate limiting for /api/login."],
};

async function successfulResult() {
  return analyzeWafAlert(
    queueMessage,
    { collectSnapshot: () => Promise.resolve(snapshot) },
    rulesConfig,
  );
}

const options = { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 };

describe("formatWeComMessage", () => {
  it("separates snapshot facts from validated AI analysis", async () => {
    const snapshotResult = await successfulResult();
    const ai: AIAnalysisResult = { status: "available", analysis };

    const message = formatWeComMessage({ snapshot: snapshotResult, ai }, options);

    expect(message).toContain("Cloudflare WAF 安全告警");
    expect(message).toContain("incident_id: correlation-123");
    expect(message).toContain("correlation_id: correlation-123");
    expect(message).toContain("快照事件数: 400");
    expect(message).toContain("Payload 参考事件数: 394");
    expect(message).toContain("192.0.2.10 220 (55%)");
    expect(message).toContain("风险等级: HIGH");
    expect(message).toContain("AI 分析");
    expect(message).toContain("GMT+8");
  });

  it("formats rule fallback without raw model text", async () => {
    const snapshotResult = await successfulResult();
    const ai = await runAIAnalysis(snapshotResult, {
      analyze: () => Promise.reject(new Error("raw model secret output")),
    });

    const message = formatWeComMessage({ snapshot: snapshotResult, ai }, options);

    expect(message).toContain("AI 分析暂不可用");
    expect(message).toContain("规则分析");
    expect(message).not.toContain("raw model secret output");
  });

  it("formats empty data and collection failures without invented facts", async () => {
    const emptySnapshot = { ...snapshot, totalEvents: 0, topIps: [], topPaths: [], actions: [] };
    const empty = await analyzeWafAlert(
      queueMessage,
      { collectSnapshot: () => Promise.resolve(emptySnapshot) },
      rulesConfig,
    );
    const emptyText = formatWeComMessage(
      { snapshot: empty, ai: { status: "unavailable", reason: "Insufficient Security Events data" } },
      options,
    );
    expect(emptyText).toContain("未查询到足够的 Security Events 数据");

    const failedText = formatWeComMessage(
      {
        snapshot: {
          status: "collection_failed",
          message: queueMessage,
          errorCode: "cloudflare_timeout",
          failure: {
            externalService: "cloudflare",
            errorCode: "cloudflare_timeout",
            failureKind: "timeout",
            retryable: true,
            durationMs: 1000,
          },
        },
        ai: { status: "unavailable", reason: "Cloudflare data unavailable" },
      },
      options,
    );
    expect(failedText).toContain("Cloudflare 数据采集失败");
    expect(failedText).not.toContain("Top IP\n1.");
  });

  it("limits long output while preserving identity, window, and status", async () => {
    const snapshotResult = await successfulResult();
    const longAnalysis: AIAnalysis = {
      ...analysis,
      summary: "x".repeat(1000),
      evidence: Array.from({ length: 10 }, () => "e".repeat(300)),
      recommendations: Array.from({ length: 3 }, () => "r".repeat(300)),
    };

    const message = formatWeComMessage(
      { snapshot: snapshotResult, ai: { status: "available", analysis: longAnalysis } },
      { ...options, maxLength: 700 },
    );

    expect(message.length).toBeLessThanOrEqual(700);
    expect(message).toContain("incident_id: correlation-123");
    expect(message).toContain("分析窗口:");
    expect(message).toContain("风险等级: HIGH");
  });
});
