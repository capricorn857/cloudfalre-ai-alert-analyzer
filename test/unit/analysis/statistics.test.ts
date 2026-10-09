import { describe, expect, it } from "vitest";

import { calculateStatistics } from "../../../src/analysis/statistics";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { queueMessage, snapshot } from "../../fixtures/domain";

describe("calculateStatistics", () => {
  it("uses GraphQL totalEvents as the only ratio denominator", () => {
    const statistics = calculateStatistics(normalizeIncident(queueMessage, snapshot));

    expect(statistics.topIp?.ratio).toBe(55);
    expect(statistics.topPath?.ratio).toBe(45);
    expect(statistics.topCountry?.ratio).toBe(62.5);
    expect(statistics.topAsn?.ratio).toBe(62.5);
    expect(statistics.allowRatio).toBe(87.5);
    expect(statistics.blockRatio).toBe(7.5);
    expect(statistics.challengeRatio).toBe(5);
    expect(statistics.userAgentConcentration?.ratio).toBe(100);
    expect(statistics.requestRatePerSecond).toBeCloseTo(400 / 1874);
  });

  it("classifies Actions by exact equality without case or whitespace folding", () => {
    const incident = normalizeIncident(queueMessage, { ...snapshot, actions: [{ value: "BLOCK", count: 100 }, { value: "block ", count: 100 }, { value: "block", count: 20 }, { value: "ALLOW", count: 100 }, { value: "CHALLENGE", count: 80 }] });
    expect(calculateStatistics(incident)).toMatchObject({ blockRatio: 5, allowRatio: 0, challengeRatio: 0 });
  });

  it("returns explicit insufficient data for a zero denominator", () => {
    const statistics = calculateStatistics(
      normalizeIncident(queueMessage, { ...snapshot, totalEvents: 0, topIps: [], actions: [] }),
    );

    expect(statistics).toMatchObject({
      totalEvents: 0,
      dataSufficient: false,
      topIp: null,
      allowRatio: null,
      requestRatePerSecond: null,
    });
    expect(JSON.stringify(statistics)).not.toMatch(/NaN|Infinity/u);
  });
});
