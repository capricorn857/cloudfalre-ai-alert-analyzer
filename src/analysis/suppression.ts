import { ScopedDiscoverySchema, DiscoveryQualitySchema, type DiscoveryQuality, type DiscoveryReasonCode, type ScopedDiscovery, type SuppressionDecision } from "../domain/event-scope";

/** Independent Adaptive observations are not an exact coverage guarantee. */
export function decideSuppression(input: ScopedDiscovery): SuppressionDecision {
  const discovery = ScopedDiscoverySchema.parse(input);
  const { rawTotalEvents: raw, zoneTotalEvents: attention, rawActions, topHosts } = discovery;
  const sum = (items: readonly {count: number}[]) => items.reduce((total, item) => total + item.count, 0);
  const unknown = (action: string | null) => action === null || action === "";
  const rawSum = sum(rawActions), nonBlock = sum(rawActions.filter((item) => !unknown(item.action) && item.action !== "block"));
  const unknownCount = sum(rawActions.filter((item) => unknown(item.action)));
  const topSum = sum(topHosts), truncated = rawActions.length >= 20;
  const duplicate = new Set(rawActions.map((item) => item.action)).size !== rawActions.length;
  const reasons: DiscoveryReasonCode[] = [];
  const add = (condition: boolean, reason: DiscoveryReasonCode) => { if (condition) reasons.push(reason); };
  add(rawSum !== raw, "raw_action_sum_mismatch");
  add(nonBlock !== attention, "attention_action_sum_mismatch");
  add(raw === 0 && (rawSum > 0 || attention > 0 || topSum > 0), "raw_zero_positive_evidence");
  add(raw > 0 && rawSum === 0, "raw_positive_no_action_evidence");
  add(attention === 0 && topSum > 0, "attention_zero_positive_host");
  add(attention === 0 && nonBlock > 0, "attention_zero_positive_non_block");
  add(topSum > attention, "top_host_sum_exceeds_attention");
  add(rawActions.some((item) => unknown(item.action)), "action_unknown");
  add(truncated, "action_distribution_truncated"); add(duplicate, "action_distribution_duplicate");
  add(topHosts.length > 0 && topSum === 0, "nonempty_zero_top_hosts");
  const comparable = attention > 0 && topSum <= attention && nonBlock === attention && !truncated && !duplicate && !rawActions.some((item) => unknown(item.action));
  const comparison = (kind: DiscoveryQuality["comparisons"][number]["kind"], left: number, right: number, relation: "eq" | "lte" = "eq") => ({kind, left, right, relation, matches: relation === "eq" ? left === right : left <= right});
  const quality: DiscoveryQuality = DiscoveryQualitySchema.parse({reasonCodes: reasons, actionDistributionTruncated: truncated, unknownActionCount: unknownCount,
    rawActionCountSum: rawSum, knownNonBlockCountSum: nonBlock, filteredTopHostCount: topHosts.length, filteredTopHostCountSum: topSum,
    zoneDenominatorComparable: comparable, invalidRatios: comparable ? [] : ["zone_share", "coverage"],
    comparisons: [comparison("raw_actions_vs_raw", rawSum, raw), comparison("non_block_actions_vs_attention", nonBlock, attention), comparison("top_hosts_vs_attention", topSum, attention, "lte"), comparison("block_vs_raw", sum(rawActions.filter((item) => item.action === "block")), raw, "lte"), comparison("attention_vs_raw", attention, raw, "lte")]});
  if (topHosts.some((item) => item.count > 0 && typeof item.host === "string" && item.host.trim().length > 0)) { if (!comparable) quality.reasonCodes.push("zone_denominator_unavailable"); return {kind: "continue", quality}; }
  if (attention > 0 || nonBlock > 0 || topSum > 0) { quality.reasonCodes.push("no_usable_hosts"); return {kind: "degrade", reason: "no_usable_hosts", quality}; }
  const complete = !truncated && !duplicate && !rawActions.some((item) => unknown(item.action)) && topHosts.length === 0;
  if (complete && raw === 0 && rawSum === 0) { quality.reasonCodes.push("raw_window_empty"); return {kind: "raw_empty", reason: "raw_window_empty", quality}; }
  if (complete && raw > 0 && rawActions.some((item) => item.action === "block" && item.count > 0) && rawActions.every((item) => item.count === 0 || item.action === "block")) {
    quality.reasonCodes.push("no_attention_events_observed"); return {kind: "suppress", reason: "no_attention_events_observed", quality};
  }
  return {kind: "degrade", reason: "suppression_ineligible", quality};
}
