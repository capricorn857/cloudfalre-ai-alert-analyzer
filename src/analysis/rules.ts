import type { RulesConfig, ThresholdSchema } from "../config/rules";
import { FindingSchema, type Finding, type FindingType } from "../domain/finding";
import type { Statistics } from "../domain/statistics";
import type { z } from "zod";

type Threshold = z.infer<typeof ThresholdSchema>;

function finding(
  type: FindingType,
  value: number | null,
  threshold: Threshold,
  evidence: string,
): Finding | null {
  if (value === null) {
    return FindingSchema.parse({
      type,
      level: "unknown",
      value: null,
      threshold: null,
      evidence: "Insufficient data",
    });
  }
  const level = value >= threshold.high ? "high" : value >= threshold.medium ? "medium" : null;
  if (level === null) return null;
  return FindingSchema.parse({
    type,
    level,
    value,
    threshold: level === "high" ? threshold.high : threshold.medium,
    evidence,
  });
}

export function evaluateRules(statistics: Statistics, config: RulesConfig): Finding[] {
  const candidates = [
    finding(
      "ip_concentration",
      statistics.topIp?.ratio ?? null,
      config.ipConcentration,
      statistics.topIp === null
        ? "Insufficient data"
        : `${statistics.topIp.value} = ${String(statistics.topIp.count)} / ${String(statistics.totalEvents)} = ${String(statistics.topIp.ratio)}%`,
    ),
    finding(
      "path_concentration",
      statistics.topPath?.ratio ?? null,
      config.pathConcentration,
      statistics.topPath === null
        ? "Insufficient data"
        : `${statistics.topPath.value} = ${String(statistics.topPath.ratio)}%`,
    ),
    finding(
      "country_concentration",
      statistics.topCountry?.ratio ?? null,
      config.countryConcentration,
      statistics.topCountry === null
        ? "Insufficient data"
        : `${statistics.topCountry.value} = ${String(statistics.topCountry.ratio)}%`,
    ),
    finding(
      "asn_concentration",
      statistics.topAsn?.ratio ?? null,
      config.asnConcentration,
      statistics.topAsn === null
        ? "Insufficient data"
        : `${statistics.topAsn.value} = ${String(statistics.topAsn.ratio)}%`,
    ),
    finding("allow_ratio", statistics.allowRatio, config.allowRatio, `allow = ${String(statistics.allowRatio)}%`),
    finding("block_ratio", statistics.blockRatio, config.blockRatio, `block = ${String(statistics.blockRatio)}%`),
    finding(
      "user_agent_concentration",
      statistics.userAgentConcentration?.ratio ?? null,
      config.userAgentConcentration,
      statistics.userAgentConcentration === null
        ? "Insufficient data"
        : `${statistics.userAgentConcentration.value} = ${String(statistics.userAgentConcentration.ratio)}% of samples`,
    ),
    finding(
      "request_rate",
      statistics.requestRatePerSecond,
      config.requestRate,
      `${String(statistics.requestRatePerSecond)} events/second`,
    ),
  ];
  return candidates.filter((item): item is Finding => item !== null);
}
