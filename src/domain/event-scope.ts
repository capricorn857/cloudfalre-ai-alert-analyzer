import { z } from "zod";

export const ATTENTION_SCOPE = { policyId: "exclude-exact-block-v1", eventScope: "attention" } as const;
export const EventScopeSchema = z.object({
  policyId: z.literal(ATTENTION_SCOPE.policyId), eventScope: z.literal(ATTENTION_SCOPE.eventScope),
});
const CountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ScopedDiscoverySchema = EventScopeSchema.extend({
  rawTotalEvents: CountSchema,
  // This is the Zone denominator AFTER filtering, never the raw snapshot total.
  zoneTotalEvents: CountSchema,
  blockedTotalEvents: CountSchema.nullable(),
  rawActions: z.array(z.object({ action: z.string().nullable(), count: CountSchema })).max(20),
  countQuality: z.literal("estimated"),
  topHosts: z.array(z.object({ host: z.string().nullable(), count: CountSchema })).max(10),
}).superRefine((value, context) => {
  for (const groups of [value.rawActions, value.topHosts]) {
    if (!Number.isSafeInteger(groups.reduce((sum, group) => sum + group.count, 0))) context.addIssue({ code: "custom", message: "unsafe count sum" });
  }
  if (new Set(value.topHosts.map((host) => host.host)).size !== value.topHosts.length) {
    context.addIssue({ code: "custom", message: "duplicate host" });
  }
});
export const DiscoveryReasonCodeSchema = z.enum([
  "raw_action_sum_mismatch", "attention_action_sum_mismatch", "raw_zero_positive_evidence", "raw_positive_no_action_evidence",
  "attention_zero_positive_host", "attention_zero_positive_non_block", "top_host_sum_exceeds_attention", "action_unknown",
  "action_distribution_truncated", "action_distribution_duplicate", "nonempty_zero_top_hosts", "no_usable_hosts",
  "host_discovery_count_mismatch", "zone_denominator_unavailable", "raw_window_empty", "no_attention_events_observed",
]);
export const DiscoveryQualitySchema = z.object({
  reasonCodes: z.array(DiscoveryReasonCodeSchema),
  actionDistributionTruncated: z.boolean(), unknownActionCount: CountSchema,
  rawActionCountSum: CountSchema, knownNonBlockCountSum: CountSchema,
  filteredTopHostCount: CountSchema, filteredTopHostCountSum: CountSchema,
  zoneDenominatorComparable: z.boolean(), invalidRatios: z.array(z.enum(["zone_share", "coverage"])),
  comparisons: z.array(z.object({kind: z.enum(["raw_actions_vs_raw", "non_block_actions_vs_attention", "top_hosts_vs_attention", "block_vs_raw", "attention_vs_raw"]), left: CountSchema, right: CountSchema, relation: z.enum(["eq", "lte"]), matches: z.boolean()})),
});
export const SuppressionDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suppress"), reason: z.literal("no_attention_events_observed"), quality: DiscoveryQualitySchema }),
  z.object({ kind: z.literal("raw_empty"), reason: z.literal("raw_window_empty"), quality: DiscoveryQualitySchema }),
  z.object({ kind: z.literal("continue"), quality: DiscoveryQualitySchema }),
  z.object({ kind: z.literal("degrade"), reason: z.enum(["aggregate_inconsistent", "action_unknown", "action_distribution_incomplete", "no_usable_hosts", "suppression_ineligible"]), quality: DiscoveryQualitySchema }),
]);
export type DiscoveryQuality = z.infer<typeof DiscoveryQualitySchema>;
export type DiscoveryReasonCode = z.infer<typeof DiscoveryReasonCodeSchema>;
export type ScopedDiscovery = z.infer<typeof ScopedDiscoverySchema>;
export type SuppressionDecision = z.infer<typeof SuppressionDecisionSchema>;
