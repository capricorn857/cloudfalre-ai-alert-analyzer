import { describe, expect, it } from "vitest";

import { evaluateRules } from "../../../src/analysis/rules";
import { calculateStatistics } from "../../../src/analysis/statistics";
import { normalizeIncident } from "../../../src/analysis/normalizer";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";

describe("evaluateRules", () => {
  it("emits deterministic findings with values, thresholds, and evidence", () => {
    const incident = normalizeIncident(queueMessage, snapshot);
    const findings = evaluateRules(calculateStatistics(incident), rulesConfig);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ip_concentration", level: "high", value: 55, threshold: 50 }),
        expect.objectContaining({ type: "path_concentration", level: "medium", value: 45 }),
        expect.objectContaining({ type: "allow_ratio", level: "high", value: 87.5 }),
        expect.objectContaining({ type: "user_agent_concentration", level: "high", value: 100 }),
      ]),
    );
    expect(findings.every((finding) => finding.evidence.length > 0)).toBe(true);
  });

  it("does not emit exaggerated findings below thresholds", () => {
    const incident = normalizeIncident(queueMessage, snapshot);
    const statistics = {
      ...calculateStatistics(incident),
      topIp: { value: "192.0.2.10", count: 20, ratio: 5 },
    };

    expect(evaluateRules(statistics, rulesConfig)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "ip_concentration" })]),
    );
  });

  it("marks every unavailable rule input as unknown", () => {
    const statistics = calculateStatistics(
      normalizeIncident(queueMessage, { ...snapshot, totalEvents: 0, topIps: [], actions: [], samples: [] }),
    );
    const findings = evaluateRules(statistics, rulesConfig);

    expect(findings).toHaveLength(8);
    expect(findings.every((finding) => finding.level === "unknown")).toBe(true);
  });
});
