import { describe, expect, it } from "vitest";

import { buildEvidenceCatalog } from "../../../src/analysis/evidence-catalog";
import { validateAIAnalysisEvidence } from "../../../src/analysis/evidence";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import type { AIAnalysis } from "../../../src/domain/ai-analysis";
import type { SnapshotAnalysisSuccess } from "../../../src/domain/analysis-result";
import { formatWeComMessage } from "../../../src/notification/formatter";
import { makeEvidenceCatalogInput } from "../../fixtures/evidence-catalog";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { structuredAnalysis } from "../../fixtures/structured-ai";

const options = { timeZone: "Asia/Shanghai", maxLength: 4000, topLimit: 5 };

function resultFor(analysis: AIAnalysis, input = makeEvidenceCatalogInput()) {
  const validated = validateAIAnalysisEvidence(analysis, buildEvidenceCatalog(input));
  const message = {
    ...queueMessage,
    incidentId: input.incident.incidentId,
    correlationId: input.incident.correlationId,
    queryStartedAt: input.incident.queryStartedAt,
    analysisWindow: input.incident.analysisWindow,
    alert: { ...queueMessage.alert, alertTime: input.incident.alertTime, resource: input.incident.resource,
      payloadEventsCount: input.incident.payloadEventsCount, dashboardLink: input.incident.dashboardLink },
  };
  const snapshotResult: SnapshotAnalysisSuccess = {
    status: "success", message, incident: input.incident, statistics: input.statistics, findings: input.findings,
  };
  return { snapshot: snapshotResult, ai: { status: "available" as const, analysis: validated } };
}

describe("formatWeComMessage", () => {
  it("renders validated observations and recommendations from controlled templates", () => {
    const analysis = structuredAnalysis();
    analysis.recommendations = [
      { kind: "review_target", evidenceIds: ["agg:path:0"] },
      { kind: "review_waf", evidenceIds: ["stat:allow", "finding:allow_ratio", "total:0"] },
      { kind: "manual_dashboard", evidenceIds: ["ctx:0"] },
    ];
    const message = formatWeComMessage(resultFor(analysis), options);
    expect(message).toContain("规则关注等级: HIGH");
    expect(message).toContain("攻击类型: Unknown");
    expect(message).toContain("攻击类型尚无法判断");
    expect(message).toContain("目标路径集中度达到配置阈值");
    expect(message).toContain("allow 比例达到配置阈值");
    expect(message).toContain("不代表已确认攻击穿透");
    expect(message).toContain("/index.php?lang=中文&mode=View");
    expect(message).toContain("人工核验 [/index.php?lang=中文&mode=View] 的访问与业务日志");
    expect(message).toContain("使用相同固定窗口核验 Cloudflare Dashboard");
  });

  it("renders every supported observation and advice with its scope qualifier", () => {
    const input = makeEvidenceCatalogInput();
    input.findings.push({ type: "block_ratio", level: "medium", value: 15, threshold: 10, evidence: "unused" });
    input.findings[input.findings.findIndex((item) => item.type === "request_rate")] =
      { type: "request_rate", level: "high", value: 100 / 1860, threshold: 0.05, evidence: "unused" };
    const analysis = structuredAnalysis();
    analysis.attack = { type: "Bot", confidence: 0.6,
      evidenceIds: ["stat:ua", "finding:user_agent_concentration", "stat:rate", "finding:request_rate"] };
    analysis.observations = [
      { kind: "aggregate_concentration", dimension: "ip", evidenceIds: ["stat:ip", "finding:ip_concentration", "total:0"] },
      { kind: "action_ratio", dimension: "block", evidenceIds: ["stat:block", "finding:block_ratio", "total:0"] },
      { kind: "action_ratio", dimension: "challenge", evidenceIds: ["stat:challenge", "total:0"] },
      { kind: "request_rate", dimension: "rate", evidenceIds: ["stat:rate", "finding:request_rate", "ctx:0"] },
      { kind: "sample_ua_concentration", dimension: "ua", evidenceIds: ["stat:ua", "finding:user_agent_concentration"] },
      { kind: "sample_observed", dimension: "sample", evidenceIds: ["sample:0"] },
    ];
    analysis.recommendations = [
      { kind: "review_source", evidenceIds: ["agg:ip:0"] },
      { kind: "verify_sample", evidenceIds: ["sample:0"] },
      { kind: "manual_dashboard", evidenceIds: ["ctx:0"] },
    ];
    const message = formatWeComMessage(resultFor(analysis, input), options);
    expect(message).toContain("疑似自动化特征（Bot，待人工核验）");
    expect(message).toContain("模型自评置信度: 0.6（不是攻击概率）");
    expect(message).toContain("本次 GraphQL 快照");
    expect(message).toContain("不代表本系统已执行封禁");
    expect(message).toContain("仅报告比例，不据此判断异常");
    expect(message).toContain("固定窗口平均 Security Events/s");
    expect(message).toContain("不代表峰值、并发或业务请求速率");
    expect(message).toContain("非空 UA 样本中");
    expect(message).toContain("ExampleClient/1.0");
    expect(message).toContain("该条样本事件（不代表总体趋势或攻击归因）");
    expect(message).toContain("[/用户/登录?Next=%2FHome&Mode=A]");
    expect(message).toContain("人工核验来源 [192.0.2.10] 是否为正常业务");
  });

  it("keeps snapshot facts independent from model selections and preserves punctuation", () => {
    const analysis = structuredAnalysis();
    analysis.observations = [];
    const message = formatWeComMessage(resultFor(analysis), options);
    expect(message).toContain("incident_id: incident-catalog-1");
    expect(message).toContain("correlation_id: correlation-catalog-1");
    expect(message).toContain("快照事件数: 100");
    expect(message).toContain("Payload 参考事件数: 101");
    expect(message).toContain("WAF/API");
    expect(message).toContain("/index.php?lang=中文&mode=View");
    expect(message).toContain("[/Index.php]");
    expect(message).toContain("[/index]");
  });

  it("rejects mismatched catalog results at the formatting boundary", () => {
    const valid = resultFor(structuredAnalysis());
    const mismatched = { ...valid, snapshot: { ...valid.snapshot,
      message: { ...valid.snapshot.message, alert: { ...valid.snapshot.message.alert, resource: "other.test" } },
      incident: { ...valid.snapshot.incident, resource: "other.test" } } };
    const message = formatWeComMessage(mismatched, options);
    expect(message).toContain("AI 分析暂不可用");
    expect(message).toContain("规则分析");
    expect(message).not.toContain("AI 分析（程序模板）");
  });

  it("rejects another snapshot even with the same resource and window", () => {
    const valid = resultFor(structuredAnalysis());
    const different = structuredClone(valid.snapshot);
    different.incident.evidence.topPaths[0] = { value: "/different.php", count: 60 };
    different.statistics.topPath = { value: "/different.php", count: 60, ratio: 60 };
    const message = formatWeComMessage({ ...valid, snapshot: different }, options);
    expect(message).toContain("AI 分析暂不可用");
    expect(message).not.toContain("AI 分析（程序模板）");
  });

  it("bounds mandatory long fields and collection-failure messages", () => {
    const input = makeEvidenceCatalogInput();
    input.incident.resource = "r".repeat(2048);
    input.incident.evidence.topPaths[0] = { value: `/${"p".repeat(2047)}`, count: 60 };
    input.statistics.topPath = { ...input.incident.evidence.topPaths[0], ratio: 60 };
    const result = resultFor(structuredAnalysis(), input);
    for (const maxLength of [900, 4000]) {
      const message = formatWeComMessage(result, { ...options, maxLength });
      expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(Math.min(2000, maxLength));
      expect(message).toContain("incident_id: incident-catalog-1");
      expect(message).toContain("分析窗口:");
      expect(message).toContain("省略");
    }
    const message = formatWeComMessage({
      snapshot: { status: "collection_failed", message: result.snapshot.message, errorCode: "cloudflare_timeout",
        failure: { externalService: "cloudflare", errorCode: "cloudflare_timeout", failureKind: "timeout", retryable: true, durationMs: 10 } },
      ai: { status: "unavailable", reason: "safe" },
    }, options);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
  });

  it("always qualifies risk, including LOW with no observations", () => {
    const input = makeEvidenceCatalogInput();
    input.findings.splice(0);
    const analysis = structuredAnalysis();
    analysis.risk = { level: "LOW", evidenceIds: ["quality:0", "total:0"] };
    analysis.observations = [];
    const message = formatWeComMessage(resultFor(analysis, input), options);
    expect(message).toContain("未命中当前关注规则");
    expect(message).toContain("不代表已证实危害");
  });

  it("visibly escapes controls and bidirectional characters", () => {
    const input = makeEvidenceCatalogInput();
    input.incident.evidence.topPaths[0] = { value: "/ok\n已封禁\u0001\u202Eevil", count: 60 };
    input.statistics.topPath = { value: "/ok\n已封禁\u0001\u202Eevil", count: 60, ratio: 60 };
    const message = formatWeComMessage(resultFor(structuredAnalysis(), input), options);
    expect(message).toContain("/ok\\n已封禁\\u0001\\u202Eevil");
    expect(message).not.toContain("/ok\n已封禁");
  });

  it("obeys UTF-8 and maxLength budgets using whole-item omission", () => {
    const input = makeEvidenceCatalogInput();
    input.incident.evidence.topPaths.push({ value: `/${"界".repeat(600)}`, count: 1 });
    const message = formatWeComMessage(resultFor(structuredAnalysis(), input), { ...options, maxLength: 900, topLimit: 10 });
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(900);
    expect(message.length).toBeLessThanOrEqual(900);
    expect(message).toContain("incident_id: incident-catalog-1");
    expect(message).toContain("分析窗口:");
    expect(message).toContain("规则关注等级: HIGH");
    expect(message).toContain("[部分低优先级内容已省略]");
    expect(message).not.toContain("界".repeat(20));
  });

  it("formats rule fallback without raw model text", async () => {
    const snapshotResult = await analyzeWafAlert(queueMessage, { collectSnapshot: () => Promise.resolve(snapshot) }, rulesConfig);
    const message = formatWeComMessage(
      { snapshot: snapshotResult, ai: { status: "unavailable", reason: "raw model secret output" } }, options,
    );
    expect(message).toContain("AI 分析暂不可用");
    expect(message).toContain("规则分析");
    expect(message).not.toContain("raw model secret output");
  });

  it("keeps the explicit empty-window status", async () => {
    const emptySnapshot = { ...snapshot, totalEvents: 0, topIps: [], topPaths: [], actions: [] };
    const snapshotResult = await analyzeWafAlert(
      queueMessage, { collectSnapshot: () => Promise.resolve(emptySnapshot) }, rulesConfig,
    );
    const message = formatWeComMessage(
      { snapshot: snapshotResult, ai: { status: "unavailable", reason: "Insufficient Security Events data" } }, options,
    );
    expect(message).toContain("当前固定分析窗口未查询到足够的 Security Events 数据");
  });
});
