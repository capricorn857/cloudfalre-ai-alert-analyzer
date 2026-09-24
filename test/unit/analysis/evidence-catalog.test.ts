import { describe, expect, it } from "vitest";

import { buildEvidenceCatalog } from "../../../src/analysis/evidence-catalog";
import { AppError } from "../../../src/observability/errors";
import { makeEvidenceCatalogInput } from "../../fixtures/evidence-catalog";

function errorDetails(action: () => unknown): AppError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("Expected AppError");
}

describe("buildEvidenceCatalog", () => {
  it("builds stable IDs in fixed type and original-array order", () => {
    const input = makeEvidenceCatalogInput();
    const first = buildEvidenceCatalog(input);
    const second = buildEvidenceCatalog(structuredClone(input));

    expect(second).toEqual(first);
    expect(new Set(first.entries.map((entry) => entry.id)).size).toBe(first.entries.length);
    expect(first.entries.map((entry) => entry.id)).toEqual([
      "ctx:0",
      "quality:0",
      "total:0",
      "agg:ip:0",
      "agg:path:0",
      "agg:path:1",
      "agg:path:2",
      "agg:host:0",
      "agg:country:0",
      "agg:asn:0",
      "agg:action:0",
      "agg:action:1",
      "agg:action:2",
      "agg:source:0",
      "stat:ip",
      "stat:path",
      "stat:country",
      "stat:asn",
      "stat:allow",
      "stat:block",
      "stat:challenge",
      "stat:rate",
      "stat:ua",
      "finding:ip_concentration",
      "finding:path_concentration",
      "finding:country_concentration",
      "finding:asn_concentration",
      "finding:allow_ratio",
      "finding:user_agent_concentration",
      "finding:request_rate",
      ...Array.from({ length: 10 }, (_, index) => `sample:${String(index)}`),
    ]);
  });

  it("preserves punctuation, case, query strings, Unicode, and distinct prefixes verbatim", () => {
    const catalog = buildEvidenceCatalog(makeEvidenceCatalogInput());
    const values = catalog.entries.flatMap((entry) => {
      if (
        entry.type === "aggregate_ip" ||
        entry.type === "aggregate_path" ||
        entry.type === "aggregate_host" ||
        entry.type === "aggregate_country" ||
        entry.type === "aggregate_asn" ||
        entry.type === "aggregate_action" ||
        entry.type === "aggregate_source"
      ) {
        return [entry.value.value];
      }
      if (entry.type === "sample") {
        return [entry.value.clientRequestPath, entry.value.source, entry.value.userAgent];
      }
      return [];
    });

    expect(values).toContain("/index.php?lang=中文&mode=View");
    expect(values).toContain("/Index.php");
    expect(values).toContain("/index");
    expect(values).toContain("/用户/登录?Next=%2FHome&Mode=A");
    expect(values).toContain("WAF/API");
    expect(values).toContain("ExampleClient/1.0");
  });

  it("limits each aggregate dimension and samples using original indexes", () => {
    const input = makeEvidenceCatalogInput();
    const sample = input.incident.samples[0];
    if (sample === undefined) throw new Error("fixture sample missing");
    input.incident.evidence.topIps = Array.from({ length: 11 }, (_, index) => ({
      value: index === 0 ? "192.0.2.10" : `192.0.2.${String(index + 10)}`,
      count: index === 0 ? 60 : 1,
    }));
    input.incident.samples = Array.from({ length: 11 }, (_, index) => ({
      ...sample,
      clientIP: `198.51.100.${String(index + 1)}`,
    }));
    input.statistics.userAgentConcentration = {
      value: "ExampleClient/1.0",
      count: 11,
      ratio: 100,
    };

    const catalog = buildEvidenceCatalog(input);

    expect(catalog.entries.filter((entry) => entry.type === "aggregate_ip")).toHaveLength(10);
    expect(catalog.entries.filter((entry) => entry.type === "sample")).toHaveLength(10);
    expect(catalog.entries.some((entry) => entry.id === "agg:ip:10")).toBe(false);
    expect(catalog.omitted).toMatchObject({ aggregateItems: 1, samples: 1 });
  });

  it("omits a complete oversized item at 2049 UTF-8 bytes and keeps one at 2048", () => {
    const input = makeEvidenceCatalogInput();
    input.incident.evidence.topHosts = [
      { value: "a".repeat(2048), count: 100 },
      { value: `${"a".repeat(2047)}中`, count: 1 },
    ];

    const catalog = buildEvidenceCatalog(input);
    const hosts = catalog.entries.filter((entry) => entry.type === "aggregate_host");

    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.value.value).toBe("a".repeat(2048));
    expect(catalog.omitted.oversizedValues).toBe(1);
    expect(catalog.omitted.aggregateItems).toBe(0);
  });

  it("uses the original non-null UA sample count as the stat denominator", () => {
    const catalog = buildEvidenceCatalog(makeEvidenceCatalogInput());
    const stat = catalog.entries.find((entry) => entry.type === "stat_ua");

    expect(stat?.value.denominator).toBe(11);
    expect(catalog.entries.filter((entry) => entry.type === "sample")).toHaveLength(10);
  });

  it("omits a finding when its oversized statistic dependency is omitted", () => {
    const input = makeEvidenceCatalogInput();
    const oversized = "中".repeat(683);
    input.incident.evidence.topPaths[0] = { value: oversized, count: 60 };
    input.statistics.topPath = { value: oversized, count: 60, ratio: 60 };

    const catalog = buildEvidenceCatalog(input);

    expect(catalog.entries.some((entry) => entry.id === "stat:path")).toBe(false);
    expect(catalog.entries.some((entry) => entry.id === "finding:path_concentration")).toBe(false);
    expect(catalog.omitted.oversizedValues).toBeGreaterThanOrEqual(2);
    expect(catalog.omitted.dependentItems).toBe(1);
    expect(catalog.entries.find((entry) => entry.type === "quality")?.value.catalogComplete).toBe(false);
  });

  it("marks naturally missing statistics unassessable without counting omission", () => {
    const input = makeEvidenceCatalogInput();
    input.statistics.topPath = null;
    input.findings.splice(
      input.findings.findIndex((finding) => finding.type === "path_concentration"),
      1,
    );

    const catalog = buildEvidenceCatalog(input);
    const quality = catalog.entries.find((entry) => entry.type === "quality");

    expect(quality?.value.riskAssessable).toBe(false);
    expect(quality?.value.catalogComplete).toBe(true);
    expect(catalog.omitted.dependentItems).toBe(0);
  });

  it("keeps an unknown finding only when its statistic dependency exists", () => {
    const withStatistic = makeEvidenceCatalogInput();
    const findingIndex = withStatistic.findings.findIndex(
      (finding) => finding.type === "path_concentration",
    );
    const finding = withStatistic.findings[findingIndex];
    if (finding === undefined) throw new Error("fixture path finding missing");
    withStatistic.findings[findingIndex] = {
      ...finding,
      level: "unknown",
      value: null,
      threshold: null,
    };
    expect(
      buildEvidenceCatalog(withStatistic).entries.some(
        (entry) => entry.id === "finding:path_concentration",
      ),
    ).toBe(true);

    const withoutStatistic = structuredClone(withStatistic);
    withoutStatistic.statistics.topPath = null;
    const catalog = buildEvidenceCatalog(withoutStatistic);
    expect(catalog.entries.some((entry) => entry.id === "finding:path_concentration")).toBe(false);
    expect(catalog.omitted.dependentItems).toBe(0);
  });

  it("builds a complete but unassessable catalog for a coherent empty snapshot", () => {
    const input = makeEvidenceCatalogInput();
    input.incident.totalEvents = 0;
    for (const values of Object.values(input.incident.evidence)) values.splice(0);
    input.incident.samples.splice(0);
    input.statistics.totalEvents = 0;
    input.statistics.topIp = null;
    input.statistics.topPath = null;
    input.statistics.topCountry = null;
    input.statistics.topAsn = null;
    input.statistics.allowRatio = null;
    input.statistics.blockRatio = null;
    input.statistics.challengeRatio = null;
    input.statistics.userAgentConcentration = null;
    input.statistics.requestRatePerSecond = null;
    input.statistics.dataSufficient = false;
    input.findings.splice(0);

    const catalog = buildEvidenceCatalog(input);
    const quality = catalog.entries.find((entry) => entry.type === "quality");

    expect(catalog.entries.map((entry) => entry.id)).toEqual(["ctx:0", "quality:0", "total:0"]);
    expect(quality?.value).toMatchObject({
      dataSufficient: false,
      riskAssessable: false,
      catalogComplete: true,
      sampleCount: 0,
      nonNullUaSampleCount: 0,
    });
  });

  it("marks the catalog incomplete when an oversized statistic has no finding", () => {
    const input = makeEvidenceCatalogInput();
    const oversized = "中".repeat(683);
    input.incident.evidence.topPaths[0] = { value: oversized, count: 60 };
    input.statistics.topPath = { value: oversized, count: 60, ratio: 60 };
    input.findings.splice(
      input.findings.findIndex((finding) => finding.type === "path_concentration"),
      1,
    );

    const catalog = buildEvidenceCatalog(input);
    const quality = catalog.entries.find((entry) => entry.type === "quality");

    expect(quality?.value.catalogComplete).toBe(false);
    expect(catalog.omitted.dependentItems).toBe(0);
  });

  it("rejects inconsistent totals, top statistics, UA counts, findings, and duplicate findings", () => {
    const mutations = [
      (input: ReturnType<typeof makeEvidenceCatalogInput>) => {
        input.statistics.totalEvents = 99;
      },
      (input: ReturnType<typeof makeEvidenceCatalogInput>) => {
        const topPath = input.statistics.topPath;
        if (topPath === null) throw new Error("fixture topPath missing");
        input.statistics.topPath = { ...topPath, value: "/other" };
      },
      (input: ReturnType<typeof makeEvidenceCatalogInput>) => {
        input.statistics.userAgentConcentration = { value: "ExampleClient/1.0", count: 12, ratio: 100 };
      },
      (input: ReturnType<typeof makeEvidenceCatalogInput>) => {
        const finding = input.findings[0];
        if (finding === undefined) throw new Error("fixture finding missing");
        input.findings[0] = { ...finding, value: 59 };
      },
      (input: ReturnType<typeof makeEvidenceCatalogInput>) => {
        const finding = input.findings[0];
        if (finding === undefined) throw new Error("fixture finding missing");
        input.findings.push({ ...finding });
      },
    ];

    for (const mutate of mutations) {
      const input = makeEvidenceCatalogInput();
      mutate(input);
      const error = errorDetails(() => buildEvidenceCatalog(input));
      expect(error).toMatchObject({
        code: "ai_catalog_invalid",
        retryable: false,
        validationStage: "catalog",
        validationReason: "inconsistent_source",
      });
    }
  });

  it("rejects invalid required context and a catalog over 128 KiB", () => {
    const invalidContext = makeEvidenceCatalogInput();
    invalidContext.incident.resource = "中".repeat(683);
    expect(errorDetails(() => buildEvidenceCatalog(invalidContext))).toMatchObject({
      validationReason: "invalid_catalog",
    });

    const overBudget = makeEvidenceCatalogInput();
    const sample = overBudget.incident.samples[0];
    if (sample === undefined) throw new Error("fixture sample missing");
    const longValue = "x".repeat(2048);
    overBudget.incident.evidence.topHosts = Array.from({ length: 10 }, () => ({ value: longValue, count: 1 }));
    overBudget.incident.evidence.actions = Array.from({ length: 10 }, () => ({ value: longValue, count: 1 }));
    overBudget.incident.evidence.sources = Array.from({ length: 10 }, () => ({ value: longValue, count: 1 }));
    overBudget.incident.samples = Array.from({ length: 10 }, (_, index) => ({
      ...sample,
      datetime: `2026-09-20T00:30:${String(index).padStart(2, "0")}.000Z`,
      action: longValue,
      clientIP: longValue,
      clientCountryName: longValue,
      clientAsn: longValue,
      clientRequestHTTPHost: longValue,
      clientRequestPath: longValue,
      source: longValue,
      userAgent: longValue,
    }));
    overBudget.statistics.userAgentConcentration = {
      value: "ExampleClient/1.0",
      count: 10,
      ratio: 100,
    };
    expect(errorDetails(() => buildEvidenceCatalog(overBudget))).toMatchObject({
      validationReason: "catalog_budget_exceeded",
    });
  });

  it("turns malformed domain input into a controlled invalid_catalog error", () => {
    const malformed = {
      incident: null,
      statistics: {},
      findings: [{ type: "path_concentration", level: "high" }],
    } as unknown as ReturnType<typeof makeEvidenceCatalogInput>;

    expect(errorDetails(() => buildEvidenceCatalog(malformed))).toMatchObject({
      code: "ai_catalog_invalid",
      retryable: false,
      validationStage: "catalog",
      validationReason: "invalid_catalog",
    });
  });

  it("does not depend on the clock", () => {
    const input = makeEvidenceCatalogInput();
    const first = buildEvidenceCatalog(input);
    const originalNow = Date.now;
    Date.now = () => 0;
    try {
      expect(buildEvidenceCatalog(input)).toEqual(first);
    } finally {
      Date.now = originalNow;
    }
  });
});
