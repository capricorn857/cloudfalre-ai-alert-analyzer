import type { AIAnalysisInput } from "../../src/analysis/evidence";

export function makeEvidenceCatalogInput(): AIAnalysisInput {
  return {
    incident: {
      incidentId: "incident-catalog-1",
      correlationId: "correlation-catalog-1",
      provider: "cloudflare",
      alertType: "waf_attack",
      resource: "example.test",
      zoneTag: "zone-catalog-test",
      alertTime: "2026-09-20T00:30:00.000Z",
      queryStartedAt: "2026-09-20T00:31:00.000Z",
      analysisWindow: {
        start: "2026-09-20T00:00:00.000Z",
        end: "2026-09-20T00:31:00.000Z",
      },
      payloadEventsCount: 101,
      totalEvents: 100,
      dashboardLink: "https://dash.cloudflare.com/example/security/events",
      evidence: {
        topIps: [{ value: "192.0.2.10", count: 60 }],
        topPaths: [
          { value: "/index.php?lang=中文&mode=View", count: 60 },
          { value: "/Index.php", count: 15 },
          { value: "/index", count: 10 },
        ],
        topHosts: [{ value: "example.test", count: 100 }],
        topCountries: [{ value: "US", count: 70 }],
        topAsns: [{ value: "AS64500", count: 70 }],
        actions: [
          { value: "allow", count: 80 },
          { value: "block", count: 15 },
          { value: "managed_challenge", count: 5 },
        ],
        sources: [{ value: "WAF/API", count: 100 }],
      },
      samples: Array.from({ length: 12 }, (_, index) => ({
        datetime: `2026-09-20T00:30:${String(index).padStart(2, "0")}.000Z`,
        action: "allow",
        clientIP: "192.0.2.10",
        clientCountryName: "US",
        clientAsn: "64500",
        clientRequestHTTPHost: "example.test",
        clientRequestPath: index === 0 ? "/用户/登录?Next=%2FHome&Mode=A" : "/index.php",
        source: "WAF/API",
        userAgent: index === 11 ? null : "ExampleClient/1.0",
      })),
    },
    statistics: {
      totalEvents: 100,
      topIp: { value: "192.0.2.10", count: 60, ratio: 60 },
      topPath: { value: "/index.php?lang=中文&mode=View", count: 60, ratio: 60 },
      topCountry: { value: "US", count: 70, ratio: 70 },
      topAsn: { value: "AS64500", count: 70, ratio: 70 },
      allowRatio: 80,
      blockRatio: 15,
      challengeRatio: 5,
      userAgentConcentration: { value: "ExampleClient/1.0", count: 11, ratio: 100 },
      requestRatePerSecond: 100 / 1860,
      dataSufficient: true,
    },
    findings: [
      { type: "ip_concentration", level: "high", value: 60, threshold: 50, evidence: "unused" },
      { type: "path_concentration", level: "high", value: 60, threshold: 50, evidence: "unused" },
      { type: "country_concentration", level: "high", value: 70, threshold: 60, evidence: "unused" },
      { type: "asn_concentration", level: "high", value: 70, threshold: 60, evidence: "unused" },
      { type: "allow_ratio", level: "high", value: 80, threshold: 80, evidence: "unused" },
      { type: "user_agent_concentration", level: "high", value: 100, threshold: 80, evidence: "unused" },
      {
        type: "request_rate",
        level: "medium",
        value: 100 / 1860,
        threshold: 0.05,
        evidence: "unused",
      },
    ],
  };
}
