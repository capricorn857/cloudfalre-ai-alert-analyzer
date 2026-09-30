import { describe, expect, it } from "vitest";

import {
  EvidenceCatalogSchema,
  type EvidenceCatalog,
  type EvidenceEntry,
} from "../../../src/domain/evidence-catalog";

const contextEntry: EvidenceEntry = {
  id: "ctx:0",
  type: "context",
  source: "incident.context",
  scope: "context",
  value: {
    resource: "example.test",
    analysisWindow: {
      start: "2026-09-20T00:00:00.000Z",
      end: "2026-09-20T00:31:00.000Z",
    },
  },
};
const qualityEntry: EvidenceEntry = {
  id: "quality:0",
  type: "quality",
  source: "derived.quality",
  scope: "context",
  value: {
    dataSufficient: false,
    riskAssessable: false,
    catalogComplete: true,
    sampleCount: 0,
    nonNullUaSampleCount: 0,
  },
};
const totalEntry: EvidenceEntry = {
  id: "total:0",
  type: "total",
  source: "statistics.totalEvents",
  scope: "aggregate",
  value: { totalEvents: 0 },
};
const requiredEntries = [contextEntry, qualityEntry, totalEntry];

function catalog(entries: EvidenceEntry[] = requiredEntries): EvidenceCatalog {
  return {
    version: 1,
    entries,
    omitted: { aggregateItems: 0, samples: 0, oversizedValues: 0, dependentItems: 0 },
  };
}

describe("EvidenceCatalogSchema", () => {
  it("accepts the strict discriminated catalog contract", () => {
    expect(EvidenceCatalogSchema.parse(catalog())).toEqual(catalog());
  });

  it("rejects source, scope, or value shapes that do not match the entry type", () => {
    const wrongSource = { ...contextEntry, source: "statistics.totalEvents" };
    const extraValue = { ...contextEntry, value: { ...contextEntry.value, zoneTag: "secret" } };

    expect(EvidenceCatalogSchema.safeParse(catalog([wrongSource as EvidenceEntry])).success).toBe(false);
    expect(EvidenceCatalogSchema.safeParse(catalog([extraValue as EvidenceEntry])).success).toBe(false);
  });

  it("rejects duplicate or malformed IDs and more than 100 entries", () => {
    expect(EvidenceCatalogSchema.safeParse(catalog([contextEntry, contextEntry])).success).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse(catalog([{ ...contextEntry, id: "CTX-0" }])).success,
    ).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse(
        catalog(Array.from({ length: 101 }, (_, index) => ({ ...contextEntry, id: `ctx:${String(index)}` }))),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown root fields and invalid omission counts", () => {
    expect(EvidenceCatalogSchema.safeParse({ ...catalog(), extension: true }).success).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse({
        ...catalog(),
        omitted: { aggregateItems: -1, samples: 0, oversizedValues: 0, dependentItems: 0 },
      }).success,
    ).toBe(false);
  });

  it("requires exactly one context, quality, and total entry", () => {
    expect(EvidenceCatalogSchema.safeParse(catalog(requiredEntries)).success).toBe(true);
    expect(EvidenceCatalogSchema.safeParse(catalog([qualityEntry, totalEntry])).success).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse(
        catalog([contextEntry, contextEntry, qualityEntry, totalEntry]),
      ).success,
    ).toBe(false);
  });

  it("enforces per-dimension, sample, and finding-type limits", () => {
    const aggregateEntries = Array.from({ length: 11 }, (_, index) => ({
      id: `agg:path:${String(index)}`,
      type: "aggregate_path" as const,
      source: "incident.evidence.topPaths" as const,
      scope: "aggregate" as const,
      value: { value: `/path-${String(index)}`, count: 1 },
    }));
    const duplicateFindings: EvidenceEntry[] = [0, 1].map((index) => ({
      id: `finding:path_concentration${index === 0 ? "" : ":1"}`,
      type: "finding",
      source: "findings",
      scope: "aggregate",
      value: {
        findingType: "path_concentration",
        level: "high",
        value: 60,
        threshold: 50,
        statId: "stat:path",
      },
    }));

    expect(
      EvidenceCatalogSchema.safeParse(catalog([...requiredEntries, ...aggregateEntries])).success,
    ).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse(catalog([...requiredEntries, ...duplicateFindings])).success,
    ).toBe(false);
  });

  it("enforces fixed IDs, strict analysis windows, individual value bytes, and total bytes", () => {
    expect(
      EvidenceCatalogSchema.safeParse(catalog([{ ...contextEntry, id: "context:0" }])).success,
    ).toBe(false);
    expect(
      EvidenceCatalogSchema.safeParse(
        catalog([
          {
            ...contextEntry,
            value: {
              ...contextEntry.value,
              analysisWindow: { ...contextEntry.value.analysisWindow, timezone: "UTC" },
            },
          } as EvidenceEntry,
        ]),
      ).success,
    ).toBe(false);

    const oversizedAggregate: EvidenceEntry = {
      id: "agg:path:0",
      type: "aggregate_path",
      source: "incident.evidence.topPaths",
      scope: "aggregate",
      value: { value: "中".repeat(683), count: 1 },
    };
    expect(
      EvidenceCatalogSchema.safeParse(catalog([...requiredEntries, oversizedAggregate])).success,
    ).toBe(false);

    const longValue = "x".repeat(2048);
    const oversizedCatalog = catalog([
      ...requiredEntries,
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `sample:${String(index)}`,
        type: "sample" as const,
        source: "incident.samples" as const,
        scope: "sample" as const,
        value: {
          datetime: "2026-09-20T00:30:00.000Z",
          action: longValue,
          clientIP: longValue,
          clientCountryName: longValue,
          clientAsn: longValue,
          clientRequestHTTPHost: longValue,
          clientRequestPath: longValue,
          source: longValue,
          userAgent: longValue,
        },
      })),
    ]);
    expect(EvidenceCatalogSchema.safeParse(oversizedCatalog).success).toBe(false);
  });

  it("rejects reordered entries and findings with inconsistent dependencies or level values", () => {
    expect(
      EvidenceCatalogSchema.safeParse(
        catalog([qualityEntry, contextEntry, totalEntry]),
      ).success,
    ).toBe(false);

    const malformedFinding: EvidenceEntry = {
      id: "finding:path_concentration",
      type: "finding",
      source: "findings",
      scope: "aggregate",
      value: {
        findingType: "path_concentration",
        level: "high",
        value: 40,
        threshold: 50,
        statId: "stat:ip",
      },
    };
    expect(
      EvidenceCatalogSchema.safeParse(
        catalog([...requiredEntries, malformedFinding]),
      ).success,
    ).toBe(false);
  });
});
