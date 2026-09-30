import { describe, expect, it } from "vitest";
import { formatWeComMessage } from "../../../src/notification/formatter";
import { analyzeHostWafAlert } from "../../../src/analyzers/waf-analyzer";
import { runHostAIAnalysis } from "../../../src/analysis/ai-analyzer";
import { makeHostAIResponse } from "../../fixtures/host-ai";
import { hostFromSnapshot } from "../../fixtures/host-analysis";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import type { HostCollection } from "../../../src/domain/host-analysis";
import type { MultiHostAIResponse } from "../../../src/domain/ai-analysis";

const options = { timeZone: "Asia/Shanghai", maxLength: 3500, topLimit: 3 };
async function resultFor(raw: HostCollection = hostFromSnapshot(snapshot), output: MultiHostAIResponse = makeHostAIResponse()) {
  const result = await analyzeHostWafAlert(queueMessage, {
    discoverZone: () => Promise.resolve({ zoneTotalEvents: raw.discoveryCount, topHosts: [{ host: raw.host, count: raw.discoveryCount }] }),
    collectHostSnapshot: () => Promise.resolve(raw),
  }, rulesConfig);
  return { snapshot: result, ai: await runHostAIAnalysis(result, { analyzeHosts: () => Promise.resolve(output) }) };
}

describe("Host formatter program templates", () => {
  it("labels validated AI advice separately from the fixed Dashboard suggestion", async () => {
    const output = makeHostAIResponse();
    const host = output.hosts[0];
    if (host?.status !== "valid") throw new Error("fixture");
    host.analysis.recommendations = [{ kind: "review_source", evidence_ids: ["h0:agg:ip:0"] }];
    const result = await resultFor(hostFromSnapshot(snapshot), output);
    expect(result.ai.status).toBe("available");
    const message = formatWeComMessage(result, options);
    expect(message).toContain("AI 分析处理建议:\nexample.test: 人工核验来源 [192.0.2.10]");
    expect(message).toContain("人工核验处理建议:\n按相同窗口人工核验 Cloudflare Dashboard");
    expect(message.indexOf("AI 分析处理建议:")).toBeGreaterThan(message.indexOf("https://dash.cloudflare.com/"));
  });
  it("does not label fallback or absent model suggestions as AI advice", async () => {
    const result = await resultFor();
    const normal = formatWeComMessage(result, options);
    expect(normal).not.toContain("AI 分析处理建议:");
    const fallback = formatWeComMessage({ ...result, ai: { status: "unavailable", hosts: [] } }, options);
    expect(fallback).toContain("规则分析处理建议:");
    expect(fallback).not.toContain("AI 分析处理建议:");
  });
  it("renders Zone, Host, protection, advice, coverage and trace data in order", async () => {
    const message = formatWeComMessage(await resultFor(), options);
    expect(message).toContain("Zone: example.test");
    expect(message).toContain("Host: example.test");
    expect(message).not.toContain("规则关注:");
    expect(message).toContain("一：Host: example.test");
    expect(message).toContain("来源 IP:\n[192.0.2.10]");
    expect(message).toContain("目标路径:\n[/api/login]");
    expect(message).toContain("https://dash.cloudflare.com/example/security/events");
    expect(message).toContain("allow 87.5%");
    expect(message).not.toContain("攻击类型未确定");
    expect(message).toContain("incident_id: correlation-123");
    expect(message).toContain("correlation_id: correlation-123");
    expect(message.indexOf("处理建议:")).toBeGreaterThan(message.lastIndexOf("来源"));
    expect(message.indexOf("分析窗口:")).toBeGreaterThan(message.indexOf("处理建议:"));
    expect(message).not.toContain("Evidence");
  });
  it.each(["/index.php", "/用户/登录?Next=%2FHome&Mode=A", "/WAF/API", "https://example.test/a?b=1"])("preserves the complete path %s", async (path) => {
    const raw = hostFromSnapshot(snapshot);
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates = { ...raw.aggregates, topPaths: [{ value: path, count: 180 }] };
    const message = formatWeComMessage(await resultFor(raw), options);
    expect(message).toContain("[" + path + "]");
    expect(message).not.toContain("该 IP 访问");
  });
  it("groups Top paths under one heading and keeps items on separate lines", async () => {
    const raw = hostFromSnapshot(snapshot);
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates.topPaths = [{ value: "/first", count: 180 }, { value: "/second", count: 100 }, { value: "/third", count: 50 }];
    const message = formatWeComMessage(await resultFor(raw), options);
    expect(message.match(/目标路径:/gu)).toHaveLength(1);
    expect(message).toContain("目标路径:\n[/first] 180（45.0%）\n[/second] 100（25.0%）\n[/third] 50（12.5%）");
  });
  it.each([undefined, "https://evil.example.test/", "https://dash.cloudflare.com.evil.test/", "http://dash.cloudflare.com/", "https://user:pass@dash.cloudflare.com/"])("uses the official Dashboard entry for an unavailable or unsafe link", async (link) => {
    const result = await resultFor();
    const alert = { ...result.snapshot.message.alert };
    delete alert.dashboardLink;
    result.snapshot.message.alert = link === undefined ? alert : { ...alert, dashboardLink: link };
    const message = formatWeComMessage(result, options);
    expect(message).toContain("Cloudflare Dashboard：\nhttps://dash.cloudflare.com/\n");
    expect(message).not.toContain("evil");
    expect(message).not.toContain("user:pass");
  });
  it("escapes controls and does not treat sample data as instructions", async () => {
    const raw = hostFromSnapshot(snapshot);
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates = { ...raw.aggregates, topPaths: [{ value: "/a\n已封禁\r\t\u202e", count: 180 }] };
    const message = formatWeComMessage(await resultFor(raw), options);
    expect(message).toContain("/a\\n已封禁\\r\\t\\u202E");
    expect(message).not.toContain("\n已封禁");
  });
  it("binds Bot qualifiers to its entire verdict", async () => {
    const raw = hostFromSnapshot(snapshot);
    raw.hostTotalEvents = 4000;
    raw.discoveryCount = 4000;
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates = { ...raw.aggregates, actions: [{ value: "allow", count: 4000 }], sources: [{ value: "waf", count: 4000 }] };
    const sample = snapshot.samples[0];
    if (sample === undefined) throw new Error("fixture sample missing");
    raw.samples = Array.from({ length: 10 }, () => ({ ...sample, clientRequestHTTPHost: raw.host }));
    const output = makeHostAIResponse();
    const host = output.hosts[0];
    if (host?.status !== "valid") throw new Error("fixture");
    host.analysis.attack = { type: "Bot", confidence: 0.6, evidence_ids: ["h0:stat:ua", "h0:finding:user_agent_concentration", "h0:stat:rate", "h0:finding:request_rate"] };
    const message = formatWeComMessage(await resultFor(raw, output), options);
    expect(message).toContain("疑似自动化特征（Bot，待人工核验）");
    expect(message).toContain("非攻击概率");
  });
  it("rejects forged or mismatched validated results during rendering", async () => {
    const first = await resultFor();
    const different = await resultFor({ ...hostFromSnapshot(snapshot), host: "other.test", samples: [] });
    const message = formatWeComMessage({ ...different, ai: first.ai }, options);
    expect(message).toContain("AI 降级");
    const forged = structuredClone(first);
    expect(formatWeComMessage(forged, options)).toContain("AI 降级");
  });
  it("omits entire oversized fields and never emits an empty heading", async () => {
    const raw = hostFromSnapshot(snapshot);
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates = { ...raw.aggregates, topPaths: [{ value: "/" + "界".repeat(2000), count: 180 }] };
    const message = formatWeComMessage(await resultFor(raw), options);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(2000);
    expect(message).not.toContain("界".repeat(20));
    expect(message).not.toMatch(/目标路径:\n(?!\[)/u);
    expect(message).toContain("分析窗口:");
  });
  it("keeps empty and collection failure states explicit", async () => {
    const empty = await resultFor({ ...hostFromSnapshot(snapshot), discoveryCount: 0, hostTotalEvents: 0, samples: [], collectionStatus: "empty" });
    expect(formatWeComMessage(empty, options)).toContain("固定窗口零事件");
    const failed = await analyzeHostWafAlert(queueMessage, {
      discoverZone: () => Promise.reject(new Error("SENSITIVE")), collectHostSnapshot: () => Promise.resolve(hostFromSnapshot(snapshot)),
    }, rulesConfig);
    const message = formatWeComMessage({ snapshot: failed, ai: { status: "unavailable", hosts: [] } }, options);
    expect(message).toContain("数据采集失败");
    expect(message).not.toContain("SENSITIVE");
  });
  it("retains the byte cap and refuses impossible lower limits", async () => {
    const result = await resultFor();
    expect(() => formatWeComMessage(result, { ...options, maxLength: 1 })).toThrow();
    const message = formatWeComMessage(result, { ...options, maxLength: 1200 });
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(1200);
    expect(message).toContain("incident_id:");
    expect(message).toContain("各排名相互独立");
  });
});
