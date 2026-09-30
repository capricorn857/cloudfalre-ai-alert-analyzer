import { z } from "zod";
import { EvidenceEntrySchema, EvidenceCatalogSchema, findingStatIds } from "./evidence-catalog";
import { HostIdSchema } from "./host-analysis";

const OwnerSchema = z.union([z.strictObject({ kind: z.literal("zone") }), z.strictObject({ kind: z.literal("host"), hostId: HostIdSchema })]);
const DenominatorSchema = z.strictObject({
  kind: z.enum(["host_events", "host_nonempty_ua_samples", "window_seconds"]),
  count: z.number().nonnegative(), referenceId: z.string().max(64),
  numerator: z.number().int().nonnegative().optional(),
});
export const ScopedEvidenceEntrySchema = z.union(EvidenceEntrySchema.options.map((schema) => schema.extend({
  owner: OwnerSchema,
  denominator: DenominatorSchema.optional(),
})));
export const HostEvidenceCatalogSchema = z.strictObject({
  version: z.literal(2),
  incidentId: z.string().min(1), correlationId: z.string().min(1),
  hostIds: z.array(HostIdSchema).max(5), unavailableHosts: z.array(HostIdSchema).max(5),
  entries: z.array(ScopedEvidenceEntrySchema).max(328),
  omitted: z.strictObject({ aggregateItems: z.number().int().nonnegative(), samples: z.number().int().nonnegative(), oversizedValues: z.number().int().nonnegative(), dependentItems: z.number().int().nonnegative() }),
}).superRefine((catalog, context) => {
  const ids = new Set<string>();
  for (const entry of catalog.entries) {
    const prefix = entry.owner.kind === "host" ? entry.owner.hostId : "zone";
    if (!entry.id.startsWith(`${prefix}:`) || ids.has(entry.id)) context.addIssue({ code: "custom", message: "invalid owner or duplicate ID" });
    ids.add(entry.id);
    const pending: unknown[] = [entry.value];
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === "string" && new TextEncoder().encode(value).byteLength > 2048) context.addIssue({ code: "custom", message: "value byte limit exceeded" });
      if (typeof value === "object" && value !== null) pending.push(...Object.values(value as Record<string, unknown>));
    }
    if (entry.owner.kind === "host" && !catalog.hostIds.includes(entry.owner.hostId)) context.addIssue({ code: "custom", message: "unknown owner" });
    if (entry.type === "finding") {
      const stat = catalog.entries.find((item) => item.id === entry.value.statId);
      const expectedId = `${prefix}:${findingStatIds[entry.value.findingType] ?? "invalid"}`;
      const statValue = stat === undefined ? null : "ratio" in stat.value ? stat.value.ratio : "eventsPerSecond" in stat.value ? stat.value.eventsPerSecond : null;
      if (entry.owner.kind !== "host" || entry.value.statId !== expectedId || stat?.owner.kind !== "host" || stat.owner.hostId !== prefix || statValue !== entry.value.value) {
        context.addIssue({ code: "custom", message: "invalid finding dependency" });
      }
    }
    if (entry.owner.kind === "host" && (entry.type.startsWith("aggregate_") || entry.type.startsWith("stat_"))) {
      const total = catalog.entries.find((item) => item.id === `${prefix}:total:0`);
      const quality = catalog.entries.find((item) => item.id === `${prefix}:quality:0`);
      const window = catalog.entries.find((item) => item.id === `${prefix}:ctx:0`);
      const denominator = entry.denominator;
      const expectedCount = entry.type === "stat_ua" && quality?.type === "quality" ? quality.value.nonNullUaSampleCount
        : entry.type === "stat_rate" && window?.type === "context" ? (Date.parse(window.value.analysisWindow.end) - Date.parse(window.value.analysisWindow.start)) / 1000
        : total?.type === "total" ? total.value.totalEvents : null;
      const expectedKind = entry.type === "stat_ua" ? "host_nonempty_ua_samples" : entry.type === "stat_rate" ? "window_seconds" : "host_events";
      const expectedId = `${prefix}:${entry.type === "stat_ua" ? "quality:0" : entry.type === "stat_rate" ? "ctx:0" : "total:0"}`;
      if (denominator?.kind !== expectedKind || denominator.count !== expectedCount || denominator.referenceId !== expectedId) context.addIssue({ code: "custom", message: "inconsistent denominator" });
      if (entry.type === "stat_ua" && entry.value.denominator !== expectedCount) context.addIssue({ code: "custom", message: "inconsistent sample denominator" });
      if ("ratio" in entry.value && "count" in entry.value && (expectedCount === null || expectedCount <= 0 || Math.round(entry.value.count / expectedCount * 100_000) / 1000 !== entry.value.ratio)) context.addIssue({ code: "custom", message: "inconsistent ratio" });
      if (entry.type === "stat_allow" || entry.type === "stat_block" || entry.type === "stat_challenge") {
        const numerator = denominator?.numerator;
        if (numerator === undefined || expectedCount === null || expectedCount <= 0 || numerator > expectedCount || Math.round(numerator / expectedCount * 100_000) / 1000 !== entry.value.ratio) context.addIssue({ code: "custom", message: "inconsistent action ratio" });
      }
      if (entry.type === "stat_rate" && (total?.type !== "total" || denominator?.numerator !== total.value.totalEvents || expectedCount === null || expectedCount <= 0 || entry.value.eventsPerSecond !== total.value.totalEvents / expectedCount)) context.addIssue({ code: "custom", message: "inconsistent event rate" });
    }
  }
  if (new Set([...catalog.hostIds, ...catalog.unavailableHosts]).size !== catalog.hostIds.length + catalog.unavailableHosts.length) context.addIssue({ code: "custom", message: "duplicate host" });
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes(catalog) > 56 * 1024) context.addIssue({ code: "custom", message: "catalog over budget" });
  const zoneEntries = catalog.entries.filter((entry) => entry.owner.kind === "zone");
  if (zoneEntries.length > 8 || zoneEntries.filter((entry) => entry.type === "context").length !== 1 || zoneEntries.filter((entry) => entry.type === "total").length !== 1) context.addIssue({ code: "custom", message: "invalid zone context" });
  for (const id of catalog.hostIds) {
    const entries = catalog.entries.filter((entry) => entry.owner.kind === "host" && entry.owner.hostId === id);
    if (entries.length > 64 || bytes(entries) > 10 * 1024) context.addIssue({ code: "custom", message: "host catalog over budget" });
    const counts = new Map<string, number>();
    const hostContext = entries.find((entry) => entry.type === "context");
    for (const entry of entries) {
      counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
      if ((entry.type.startsWith("aggregate_") || entry.type === "sample") && (counts.get(entry.type) ?? 0) > 5) context.addIssue({ code: "custom", message: "host dimension limit" });
      if (entry.type === "sample" && (hostContext?.type !== "context" || entry.value.clientRequestHTTPHost !== hostContext.value.resource)) context.addIssue({ code: "custom", message: "sample host mismatch" });
    }
    const localEntries = entries.map((entry) => ({ id: entry.id.slice(id.length + 1), type: entry.type, source: entry.source, scope: entry.scope,
      value: entry.type === "finding" ? { ...entry.value, statId: entry.value.statId.slice(id.length + 1) } : entry.value }));
    if (!EvidenceCatalogSchema.safeParse({ version: 1, entries: localEntries, omitted: { aggregateItems: 0, samples: 0, oversizedValues: 0, dependentItems: 0 } }).success) context.addIssue({ code: "custom", message: "invalid host namespace" });
  }
});
export type ScopedEvidenceEntry = z.infer<typeof ScopedEvidenceEntrySchema>;
export type HostEvidenceCatalog = z.infer<typeof HostEvidenceCatalogSchema>;
