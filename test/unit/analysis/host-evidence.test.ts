import { describe, expect, it } from "vitest";
import { buildHostEvidenceCatalog, validateHostAIAnalysis } from "../../../src/analysis/host-evidence";
import { analyzeHost } from "../../../src/analysis/host-analysis";
import { makeHost, hostWindow } from "../../fixtures/host-analysis";
import { rulesConfig, queueMessage } from "../../fixtures/domain";
import { HostEvidenceCatalogSchema } from "../../../src/domain/host-evidence";

const host = analyzeHost(makeHost(), 1000, hostWindow, rulesConfig);
const other = analyzeHost(makeHost("h1", "www.example.test", 300), 1000, hostWindow, rulesConfig);
const input = { message: { ...queueMessage, analysisWindow: hostWindow }, zoneTotalEvents: 1000, hosts: [host, other] };
const unknown = { host_id: "h0", risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] }, observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: ["h0:ctx:0"] }] };

describe("Host evidence ownership", () => {
  it("builds stable v2 evidence with explicit denominator and Host namespaces", () => {
    const catalog = buildHostEvidenceCatalog(input);
    expect(catalog.version).toBe(2);
    expect(catalog).toEqual(buildHostEvidenceCatalog(structuredClone(input)));
    expect(catalog.entries.find((entry) => entry.id === "h0:stat:path")).toMatchObject({ owner: { kind: "host", hostId: "h0" }, denominator: { kind: "host_events", count: 600, referenceId: "h0:total:0" } });
    expect(catalog.entries.find((entry) => entry.id === "h0:stat:ua")).toMatchObject({ denominator: { kind: "host_nonempty_ua_samples", count: 10 } });
    expect(validateHostAIAnalysis(unknown, catalog).hostId).toBe("h0");
  });
  it("rejects cross Host evidence and independent-rank relationship fields", () => {
    const catalog = buildHostEvidenceCatalog(input);
    expect(() => validateHostAIAnalysis({ ...unknown, recommendations: [{ kind: "review_source", evidence_ids: ["h1:agg:ip:0"] }] }, catalog)).toThrow(expect.objectContaining({ code: "ai_reference_invalid" }));
    expect(() => validateHostAIAnalysis({ ...unknown, joint_relationship: "ASN accessed path" }, catalog)).toThrow();
  });
  it("rejects wrong source denominators before calling AI", () => {
    const bad = structuredClone(input);
    if (!bad.hosts[0]?.statistics?.topPath) throw new Error("fixture missing");
    bad.hosts[0].statistics.topPath.ratio = 30;
    const catalog = buildHostEvidenceCatalog(bad);
    expect(catalog.unavailableHosts).toContain("h0");
    expect(catalog.hostIds).toEqual(["h1"]);
  });
  it("keeps catalogs bounded and unsupported attacks rejected", () => {
    const catalog = buildHostEvidenceCatalog(input);
    expect(new TextEncoder().encode(JSON.stringify(catalog)).byteLength).toBeLessThanOrEqual(56 * 1024);
    expect(() => validateHostAIAnalysis({ ...unknown, attack: { type: "Brute Force", confidence: 0.5, evidence_ids: ["h0:agg:path:0"] } }, catalog)).toThrow();
  });
  it("rejects altered denominator metadata and freezes the validated display object", () => {
    const catalog = buildHostEvidenceCatalog(input);
    const altered = structuredClone(catalog);
    const stat = altered.entries.find((entry) => entry.id === "h0:stat:path");
    if (!stat?.denominator) throw new Error("fixture denominator missing");
    stat.denominator.count = 1000;
    expect(() => validateHostAIAnalysis(unknown, altered)).toThrow();
    const validated = validateHostAIAnalysis(unknown, catalog);
    expect(Object.isFrozen(validated.wire.attack)).toBe(true);
    expect(Object.isFrozen(validated.catalog.entries)).toBe(true);
  });
  it.each(["h1:stat:path", "h0:stat:missing"])("rejects a Finding dependency %s before namespace conversion", (statId) => {
    const catalog = buildHostEvidenceCatalog(input);
    const finding = catalog.entries.find((entry) => entry.id === "h0:finding:path_concentration");
    if (finding?.type !== "finding") throw new Error("fixture Finding missing");
    finding.value.statId = statId;
    expect(HostEvidenceCatalogSchema.safeParse(catalog).success).toBe(false);
    expect(() => validateHostAIAnalysis(unknown, catalog)).toThrow();
  });
  it.each(["stat_block", "stat_rate"] as const)("rejects a corrupted %s formula", (type) => {
    const catalog = buildHostEvidenceCatalog(input);
    const entry = catalog.entries.find((value) => value.owner.kind === "host" && value.owner.hostId === "h0" && value.type === type);
    if (entry?.type === "stat_block") entry.value.ratio = 99;
    else if (entry?.type === "stat_rate") entry.value.eventsPerSecond += 1;
    else throw new Error("fixture statistic missing");
    expect(HostEvidenceCatalogSchema.safeParse(catalog).success).toBe(false);
  });
  it("rejects a sample whose actual Host disagrees with its owner namespace", () => {
    const catalog = buildHostEvidenceCatalog(input);
    const sample = catalog.entries.find((entry) => entry.id === "h0:sample:0");
    if (sample?.type !== "sample") throw new Error("fixture sample missing");
    sample.value.clientRequestHTTPHost = "www.example.test";
    expect(HostEvidenceCatalogSchema.safeParse(catalog).success).toBe(false);
  });
  it("trims oversized optional evidence without discarding a representable Host", () => {
    const raw = makeHost();
    if (raw.aggregates === null) throw new Error("fixture aggregates missing");
    for (const dimension of ["topIps", "topPaths", "topCountries", "topAsns"] as const) {
      raw.aggregates[dimension] = Array.from({ length: 10 }, (_, index) => ({ value: index === 0 ? "top" : String(index) + "x".repeat(2000), count: 20 }));
    }
    raw.samples = Array.from({ length: 10 }, () => ({ datetime: hostWindow.start, clientRequestHTTPHost: raw.host,
      action: "x".repeat(2000), clientIP: "x".repeat(2000), clientCountryName: "x".repeat(2000), clientAsn: "x".repeat(2000),
      clientRequestPath: "x".repeat(2000), source: "x".repeat(2000), userAgent: "x".repeat(2000) }));
    const catalog = buildHostEvidenceCatalog({ ...input, hosts: [analyzeHost(raw, 1000, hostWindow, rulesConfig)] });
    expect(catalog.hostIds).toEqual(["h0"]);
    expect(catalog.unavailableHosts).toEqual([]);
    expect(catalog.omitted.samples + catalog.omitted.aggregateItems).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(catalog.entries.filter((entry) => entry.owner.kind === "host"))).byteLength).toBeLessThanOrEqual(10 * 1024);
    expect(catalog.entries.find((entry) => entry.id === "h0:stat:ua")).toMatchObject({ denominator: { count: 10 } });
  });
});
