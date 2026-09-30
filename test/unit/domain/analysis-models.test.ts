import { describe, expect, it } from "vitest";

import { AIAnalysisSchema } from "../../../src/domain/ai-analysis";
import { FindingSchema } from "../../../src/domain/finding";
import { IncidentSchema } from "../../../src/domain/incident";
import { StatisticsSchema } from "../../../src/domain/statistics";
import { structuredAnalysis } from "../../fixtures/structured-ai";

describe("analysis domain schemas", () => {
  it("accepts a normalized incident without raw responses", () => {
    const result = IncidentSchema.parse({
      incidentId: "incident-1",
      correlationId: "correlation-1",
      provider: "cloudflare",
      alertType: "waf_attack",
      resource: "example.test",
      zoneTag: "zone-test",
      alertTime: "2026-09-14T09:18:46.000Z",
      queryStartedAt: "2026-09-14T09:20:00.000Z",
      analysisWindow: {
        start: "2026-09-14T08:48:46.000Z",
        end: "2026-09-14T09:20:00.000Z",
      },
      payloadEventsCount: 394,
      totalEvents: 400,
      evidence: {
        topIps: [{ value: "192.0.2.10", count: 220 }],
        topPaths: [{ value: "/api/login", count: 180 }],
        topHosts: [{ value: "example.test", count: 400 }],
        topCountries: [{ value: "US", count: 250 }],
        topAsns: [{ value: "AS64500", count: 250 }],
        actions: [{ value: "allow", count: 350 }],
        sources: [{ value: "firewallCustom", count: 400 }],
      },
      samples: [],
    });

    expect(result.totalEvents).toBe(400);
    expect(result).not.toHaveProperty("rawResponse");
  });

  it("represents unavailable ratios as null", () => {
    const result = StatisticsSchema.parse({
      totalEvents: 0,
      topIp: null,
      topPath: null,
      topCountry: null,
      topAsn: null,
      allowRatio: null,
      blockRatio: null,
      challengeRatio: null,
      userAgentConcentration: null,
      requestRatePerSecond: null,
      dataSufficient: false,
    });

    expect(result.dataSufficient).toBe(false);
  });

  it("validates findings and AI output bounds", () => {
    expect(
      FindingSchema.parse({
        type: "ip_concentration",
        level: "high",
        value: 55,
        threshold: 50,
        evidence: "192.0.2.10 = 220 / 400 = 55%",
      }).level,
    ).toBe("high");

    const analysis = structuredAnalysis();
    expect(AIAnalysisSchema.parse(analysis)).toEqual(analysis);
    expect(() => AIAnalysisSchema.parse({ ...analysis, attack: { ...analysis.attack, confidence: 2 } })).toThrow();
    expect(() =>
      AIAnalysisSchema.parse({ ...analysis, recommendations: ["1", "2", "3", "4"] }),
    ).toThrow();
  });
});
