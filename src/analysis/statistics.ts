import type { EvidenceItem, Incident } from "../domain/incident";
import { StatisticsSchema, type Concentration, type Statistics } from "../domain/statistics";

export interface StatisticsInput {
  readonly totalEvents: number;
  readonly analysisWindow: Incident["analysisWindow"];
  readonly evidence: Pick<Incident["evidence"], "topIps" | "topPaths" | "topCountries" | "topAsns" | "actions">;
  readonly samples: Incident["samples"];
  readonly actionsComplete?: boolean;
}

function ratio(count: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((count / total) * 100_000) / 1000;
}

function concentration(items: readonly EvidenceItem[], total: number): Concentration | null {
  const top = items[0];
  if (top === undefined || total <= 0 || items.reduce((sum, item) => sum + item.count, 0) > total) return null;
  return { ...top, ratio: ratio(top.count, total) ?? 0 };
}

function actionRatio(incident: StatisticsInput, actions: readonly string[]): number | null {
  if (incident.totalEvents <= 0 || incident.actionsComplete === false) return null;
  const allowed = new Set(actions);
  const count = incident.evidence.actions
    .filter((item) => allowed.has(item.value.toLowerCase()))
    .reduce((total, item) => total + item.count, 0);
  return ratio(count, incident.totalEvents);
}

function userAgentConcentration(incident: StatisticsInput): Concentration | null {
  const values = incident.samples
    .map((sample) => sample.userAgent)
    .filter((value): value is string => value !== null && value.trim().length > 0);
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  if (top === undefined) return null;
  return { value: top[0], count: top[1], ratio: ratio(top[1], values.length) ?? 0 };
}

export function calculateStatistics(incident: StatisticsInput): Statistics {
  const durationSeconds =
    (Date.parse(incident.analysisWindow.end) - Date.parse(incident.analysisWindow.start)) / 1000;
  const dataSufficient = incident.totalEvents > 0;

  return StatisticsSchema.parse({
    totalEvents: incident.totalEvents,
    topIp: concentration(incident.evidence.topIps, incident.totalEvents),
    topPath: concentration(incident.evidence.topPaths, incident.totalEvents),
    topCountry: concentration(incident.evidence.topCountries, incident.totalEvents),
    topAsn: concentration(incident.evidence.topAsns, incident.totalEvents),
    allowRatio: actionRatio(incident, ["allow"]),
    blockRatio: actionRatio(incident, ["block"]),
    challengeRatio: actionRatio(incident, ["challenge", "managed_challenge"]),
    userAgentConcentration: dataSufficient ? userAgentConcentration(incident) : null,
    requestRatePerSecond:
      dataSufficient && durationSeconds > 0 ? incident.totalEvents / durationSeconds : null,
    dataSufficient,
  });
}
