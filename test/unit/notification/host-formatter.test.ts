import { describe, expect, it } from "vitest";
import { formatHostWeComMessage } from "../../../src/notification/host-formatter";
import { analyzeHostWafAlert } from "../../../src/analyzers/waf-analyzer";
import { makeHost } from "../../fixtures/host-analysis";
import { queueMessage, rulesConfig } from "../../fixtures/domain";
import type { HostAIAnalysisResult } from "../../../src/analysis/ai-analyzer";
import { runHostAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { makeNotificationFixture } from "../../fixtures/host-notifications";

const options = { timeZone: "Asia/Shanghai", maxLength: 3500, topLimit: 3 };
async function snapshot(count = 2) {
  return analyzeHostWafAlert({ ...queueMessage, configSnapshot: { ...queueMessage.configSnapshot, hostLimit: count } }, {
    discoverZone: () => Promise.resolve({ zoneTotalEvents: 2000, topHosts: Array.from({ length: count }, (_, i) => ({ host: `host${String(i)}.example.test`, count: 300 })) }),
    collectHostSnapshot: (_input, host) => Promise.resolve(makeHost(host.hostId, host.host, host.discoveryCount)),
  }, rulesConfig);
}
const fallback: HostAIAnalysisResult = { status: "unavailable", hosts: [] };

describe("single multi Host text notification", () => {
  it.each(["normal", "partial", "ai_fallback", "long"] as const)("renders the complete fictional %s scenario", async (scenario) => {
    const fixture = makeNotificationFixture(scenario);
    const result = await analyzeHostWafAlert(fixture.message, {
      discoverZone: () => Promise.resolve(fixture.discovery), collectHostSnapshot: (_input, host) => {
        const value = fixture.collections.find((collection) => collection.hostId === host.hostId);
        if (value === undefined) throw new Error("fixture Host missing");
        return Promise.resolve(value);
      },
    }, rulesConfig);
    const ai = await runHostAIAnalysis(result, { analyzeHosts: () => fixture.aiFailure ? Promise.reject(new Error("fictional failure")) : Promise.resolve(fixture.ai) });
    const message = formatHostWeComMessage({ snapshot: result, ai }, options);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
    for (const label of ["Zone:", "Host:", "处理建议:", "分析窗口:", "覆盖:", "incident_id:", "correlation_id:"]) expect(message).toContain(label);
    if (scenario === "normal") expect(message).not.toContain("AI 降级");
    if (scenario === "partial") expect(message).toContain("发现阶段: 300 事件（未完成分析）");
    if (scenario === "ai_fallback") expect(message).toContain("AI 降级");
    if (scenario === "long") expect(message).toContain("明细已省略");
    expect(message).not.toContain("攻击类型未确定");
    expect(message).not.toMatch(/规则关注: [^\n]*；\n/u);
    expect(message).not.toContain("规则关注:");
    expect(message).toContain("各排名相互独立");
  });
  it("groups Host facts before advice and keeps identifiers and coverage", async () => {
    const message = formatHostWeComMessage({ snapshot: await snapshot(), ai: fallback }, options);
    expect(message).toContain("Zone: example.test");
    expect(message).toContain("Host: host0.example.test");
    expect(message).toContain("Host: host1.example.test");
    expect(message).toContain("一：Host: host0.example.test");
    expect(message).toContain("二：Host: host1.example.test");
    expect(message.indexOf("处理建议:")).toBeGreaterThan(message.lastIndexOf("目标路径:"));
    expect(message).toContain("30.0%");
    expect(message).toContain("incident_id: correlation-123");
    expect(message).toContain("AI 降级");
    expect(message).not.toContain("Evidence");
    expect(message).not.toContain("全部攻击已阻止");
  });
  it("orders precomputed HIGH, MEDIUM, Unknown and LOW attention without recalculating them", async () => {
    const result = await snapshot(4);
    if (result.status === "collection_failed") throw new Error("fixture");
    const levels = ["LOW", "Unknown", "HIGH", "MEDIUM"] as const;
    result.incident.hosts.forEach((host, index) => { host.ruleAttention = levels[index] ?? "Unknown"; });
    const message = formatHostWeComMessage({ snapshot: result, ai: fallback }, options);
    const positions = [2, 3, 1, 0].map((index) => message.indexOf("Host: host" + String(index) + ".example.test"));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(message).toContain("不代表安全");
  });
  it("keeps five hosts and full IDs under the UTF-8 limit with long details", async () => {
    const result = await snapshot(5);
    if (result.status === "collection_failed") throw new Error("fixture failed");
    for (const host of result.incident.hosts) if (host.collection.aggregates) host.collection.aggregates.topPaths = [{ value: "/" + "界".repeat(2000), count: 100 }];
    const message = formatHostWeComMessage({ snapshot: result, ai: fallback }, options);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
    for (let i = 0; i < 5; i++) expect(message).toContain(`host${String(i)}.example.test`);
    expect(message).toContain("分析窗口:");
    expect(message).toContain("correlation_id: correlation-123");
    expect(message).not.toMatch(/目标路径:\n(?!\[)/u);
  });
  it("refuses an unrepresentable message instead of dropping trace identifiers", async () => {
    const result = await snapshot();
    expect(() => formatHostWeComMessage({ snapshot: result, ai: fallback }, { ...options, maxLength: 1 })).toThrow();
    const oversized = { ...result, message: { ...result.message, incidentId: "x".repeat(3000) } };
    expect(() => formatHostWeComMessage({ snapshot: oversized, ai: fallback }, options)).toThrow(expect.objectContaining({ code: "notification_content_unrepresentable" }));
  });
  it("preserves two maximal normal identifiers with five Host result blocks", async () => {
    const result = await snapshot(5);
    const message = formatHostWeComMessage({ snapshot: { ...result, message: { ...result.message, incidentId: "i".repeat(128), correlationId: "c".repeat(128) } }, ai: fallback }, options);
    expect(message).toContain("incident_id: " + "i".repeat(128));
    expect(message).toContain("correlation_id: " + "c".repeat(128));
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
    for (let i = 0; i < 5; i++) expect(message).toContain("host" + String(i) + ".example.test");
  });
  it("does not mistake rounded 100.0 percent for an exact all-block outcome", async () => {
    const result = await snapshot(1);
    if (result.status === "collection_failed") throw new Error("fixture");
    const host = result.incident.hosts[0];
    if (host?.statistics === null || host?.collection.aggregates == null) throw new Error("fixture");
    host.statistics.totalEvents = 2500;
    host.statistics.blockRatio = 99.96;
    host.collection.aggregates.actions = [{ value: "block", count: 2499 }, { value: "allow", count: 1 }];
    const message = formatHostWeComMessage({ snapshot: result, ai: fallback }, options);
    expect(message).toContain("block 100.0%");
    expect(message).not.toContain("全部标记为 block");
  });
  it("losslessly represents maximal control-character identifiers with five Hosts", async () => {
    const result = await snapshot(5);
    const id = "\u0001".repeat(128);
    const message = formatHostWeComMessage({ snapshot: { ...result, message: { ...result.message, incidentId: id, correlationId: id } }, ai: fallback }, options);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
    for (const label of ["incident_id", "correlation_id"]) {
      const value = message.split("\n").find((line) => line.startsWith(label + ": "))?.slice(label.length + 2);
      expect(value?.startsWith("[utf8-base64:")).toBe(true);
      const encoded = value?.slice("[utf8-base64:".length, -1) ?? "";
      expect(atob(encoded)).toBe(id);
    }
    expect(message.match(/Host:/gu)).toHaveLength(5);
  });
  it("shows discovery-only counts for a failed Host without presenting them as analyzed totals", async () => {
    const result = await analyzeHostWafAlert(queueMessage, {
      discoverZone: () => Promise.resolve({ zoneTotalEvents: 1000, topHosts: [{ host: "example.test", count: 600 }, { host: "www.example.test", count: 300 }] }),
      collectHostSnapshot: (_input, host) => host.hostId === "h1" ? Promise.reject(new Error("failed")) : Promise.resolve(makeHost(host.hostId, host.host, host.discoveryCount)),
    }, rulesConfig);
    const message = formatHostWeComMessage({ snapshot: result, ai: fallback }, options);
    expect(message).toContain("事件数未知");
    expect(message).toContain("发现阶段: 300 事件（未完成分析）");
    expect(message).toContain("60.0%");
  });
  it("marks omitted details inside each affected Host section", async () => {
    const message = formatHostWeComMessage({ snapshot: await snapshot(5), ai: fallback }, options);
    const hostSections = message.split("处理建议:")[0]?.split("Host:").slice(1) ?? [];
    const omitted = hostSections.filter((section) => !section.includes("来源 ASN:") || !section.includes("目标路径:"));
    expect(omitted.length).toBeGreaterThan(0);
    for (const section of omitted) expect(section).toContain("明细已省略");
  });
  it("retains all failure states with five Hosts and maximum trace IDs", async () => {
    const result = await analyzeHostWafAlert({ ...queueMessage, configSnapshot: { ...queueMessage.configSnapshot, hostLimit: 5 } }, {
      discoverZone: () => Promise.resolve({ zoneTotalEvents: 2000, topHosts: Array.from({ length: 5 }, (_, i) => ({ host: "host" + String(i) + ".example.test", count: 300 })) }),
      collectHostSnapshot: (_input, selected) => Promise.resolve({ ...makeHost(selected.hostId, selected.host, 300), hostTotalEvents: 301, collectionStatus: "partial", samplesStatus: "failed", samples: [], errorCode: "cloudflare_timeout" }),
    }, rulesConfig);
    const id = "\u0001".repeat(128);
    const message = formatHostWeComMessage({ snapshot: { ...result, message: { ...result.message, incidentId: id, correlationId: id } }, ai: fallback }, options);
    expect(message.match(/Host:/gu)).toHaveLength(5);
    expect(message.match(/样本.*失败/gu)).toHaveLength(5);
    expect(message.match(/AI.*降级/gu)).toHaveLength(5);
    for (let i = 0; i < 5; i++) expect(message).toContain("host" + String(i) + ".example.test");
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
  });
});
