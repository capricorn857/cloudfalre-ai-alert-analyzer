import { ATTENTION_SCOPE } from "../../../src/domain/event-scope";
import { attentionCounts } from "../../fixtures/blocked-events";
import { describe, expect, it } from "vitest";
import { analyzeHost, summarizeCoverage, selectHosts } from "../../../src/analysis/host-analysis";
import { makeHost, hostWindow } from "../../fixtures/host-analysis";
import { rulesConfig } from "../../fixtures/domain";

describe("independent Host analysis", () => {
  it("keeps same paths, sources and denominators independent", () => {
    const a = analyzeHost(makeHost(), 1000, hostWindow, rulesConfig);
    const b = analyzeHost(makeHost("h1", "www.example.test", 300), 1000, hostWindow, rulesConfig);
    expect(a.statistics).toMatchObject({ totalEvents: 600, hostId: "h0", zoneShare: 60, topPath: { ratio: 50 }, userAgentConcentration: { ratio: 60 }, nonEmptyUaSampleCount: 10, blockRatio: 0 });
    expect(b.statistics).toMatchObject({ totalEvents: 300, hostId: "h1", zoneShare: 30, topPath: { ratio: 10 }, allowRatio: 100 });
    expect(a.statistics?.requestRatePerSecond).toBeCloseTo(600 / 1860);
    expect(a.findings.every((finding) => finding.hostId === "h0")).toBe(true);
    expect(summarizeCoverage(1000, [a, b])).toMatchObject({ analyzedHostCount: 2, failedHostCount: 0, coverage: { events: 900, ratio: 90, status: "comparable" } });
  });
  it("retains successful host coverage while failures remain unknown", () => {
    const good = analyzeHost(makeHost(), 1000, hostWindow, rulesConfig);
    const failed = analyzeHost({ ...ATTENTION_SCOPE, hostId: "h1", host: "www.example.test", discoveryCount: 300, hostTotalEvents: null, aggregates: null, samples: [], samplesStatus: "not_requested", collectionStatus: "failed", errorCode: "cloudflare_timeout" }, 1000, hostWindow, rulesConfig);
    expect(failed.statistics).toBeNull();
    expect(summarizeCoverage(1000, [good, failed])).toMatchObject({ analyzedHostCount: 1, failedHostCount: 1, coverage: { ratio: 60 } });
  });
  it("does not normalize inconsistent aggregates or compare mismatched discovery totals", () => {
    const raw = makeHost();
    if (!raw.aggregates) throw new Error("fixture aggregates missing");
    raw.aggregates.actions[0] = { value: "log", count: 601 };
    raw.discoveryCount = 610;
    const a = analyzeHost(raw, 1000, hostWindow, rulesConfig);
    expect(a.statistics?.blockRatio).toBeNull();
    expect(a.statistics?.zoneShare).toBeNull();
    expect(a.ruleAttention).toBe("Unknown");
    expect(summarizeCoverage(1000, [a]).coverage).toMatchObject({ ratio: null, status: "inconsistent" });
  });
  it("selects bounded positive nonempty hosts deterministically", () => {
    expect(selectHosts({ ...attentionCounts(100), topHosts: [{ host: null, count: 40 }, { host: "b.test", count: 20 }, { host: "a.test", count: 20 }, { host: " ", count: 10 }, { host: "c.test", count: 0 }] }, 1)).toMatchObject({
      hosts: [{ hostId: "h0", host: "a.test", discoveryCount: 20 }], topHostsTruncated: true, invalidHostEvents: 50,
    });
  });
  it("does not treat sample failure as zero or change aggregate coverage", () => {
    const a = analyzeHost({ ...makeHost(), samples: [], samplesStatus: "failed", collectionStatus: "partial", errorCode: "cloudflare_timeout" }, 1000, hostWindow, rulesConfig);
    expect(a.statistics?.userAgentConcentration).toBeNull();
    expect(summarizeCoverage(1000, [a])).toMatchObject({ sampleFailedHostCount: 1, analyzedHostCount: 1, coverage: { ratio: 60 } });
  });
  it("keeps zero counts and zero-duration windows explicitly insufficient", () => {
    const raw = makeHost();
    raw.hostTotalEvents = 0; raw.discoveryCount = 0; raw.collectionStatus = "empty"; raw.samples = [];
    raw.aggregates = { topIps: [], topPaths: [], topCountries: [], topAsns: [], actions: [], sources: [] };
    const zero = analyzeHost(raw, 0, hostWindow, rulesConfig);
    expect(zero.statistics).toMatchObject({ dataSufficient: false, topPath: null, blockRatio: null, requestRatePerSecond: null });
    expect(zero.ruleAttention).toBe("Unknown");
    expect(summarizeCoverage(0, [zero]).coverage).toMatchObject({ ratio: null, status: "empty" });
    expect(analyzeHost(makeHost(), 1000, { start: hostWindow.start, end: hostWindow.start }, rulesConfig).statistics?.requestRatePerSecond).toBeNull();
  });
  it.each(["actions", "sources"] as const)("treats a full-limit %s list as potentially truncated", (dimension) => {
    const raw = makeHost();
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates[dimension] = Array.from({ length: 20 }, (_, i) => ({ value: "category" + String(i), count: 30 }));
    const result = analyzeHost(raw, 1000, hostWindow, rulesConfig);
    expect(result.quality[dimension === "actions" ? "actionsComplete" : "sourcesComplete"]).toBe(false);
    expect(result.ruleAttention).toBe("Unknown");
  });
  it("preserves independent useful counts while rejecting a dimension over its denominator", () => {
    const raw = makeHost();
    if (raw.aggregates === null) throw new Error("fixture");
    raw.aggregates.topPaths = [{ value: "/login", count: 601 }];
    const result = analyzeHost(raw, 1000, hostWindow, rulesConfig);
    expect(result.statistics?.topPath).toBeNull();
    expect(result.statistics?.topIp?.ratio).toBe(60);
    expect(result.findings.find((finding) => finding.type === "path_concentration")?.level).toBe("unknown");
  });
  it("reports top-ten truncation without inferring the full Host count", () => {
    const selection = selectHosts({ ...attentionCounts(2000), topHosts: Array.from({ length: 10 }, (_, index) => ({ host: "h" + String(index) + ".test", count: 100 })) }, 3);
    expect(selection.hosts).toHaveLength(3);
    expect(selection.topHostsTruncated).toBe(true);
    expect(selection).not.toHaveProperty("totalHosts");
  });
});

it("retains Host ratios while explicit Zone comparability disables shares and coverage", () => {
  const host = analyzeHost(makeHost(), 1000, hostWindow, rulesConfig, false);
  expect(host.statistics).toMatchObject({zoneShare: null, topPath: {ratio: 50}, allowRatio: 0});
  expect(host.quality.discoveryConsistent).toBe(true);
  expect(summarizeCoverage(1000, [host], false).coverage.ratio).toBeNull();
});
