import { ScopedDiscoverySchema, type ScopedDiscovery, type SuppressionDecision } from "../domain/event-scope";

/** An observation policy, not a proof of absence in the underlying requests. */
export function decideSuppression(input: ScopedDiscovery): SuppressionDecision {
  const discovery = ScopedDiscoverySchema.parse(input);
  const { rawTotalEvents: raw, zoneTotalEvents: attention, blockedTotalEvents: blocked, rawActions, topHosts } = discovery;
  if (rawActions.some((group) => group.count > 0 && (group.action === null || group.action.length === 0))) {
    return { kind: "degrade", reason: "action_unknown" };
  }
  if (rawActions.length >= 20 || new Set(rawActions.map((group) => group.action)).size !== rawActions.length || blocked === null) {
    return { kind: "degrade", reason: "action_distribution_incomplete" };
  }
  const rawActionTotal = rawActions.reduce((sum, group) => sum + group.count, 0);
  const observedBlocked = rawActions.filter((group) => group.action === "block").reduce((sum, group) => sum + group.count, 0);
  const observedAttention = rawActions.filter((group) => group.action !== "block").reduce((sum, group) => sum + group.count, 0);
  if (!Number.isSafeInteger(rawActionTotal) || rawActionTotal !== raw || observedBlocked !== blocked || observedAttention !== attention) {
    return { kind: "degrade", reason: "aggregate_inconsistent" };
  }
  if (attention > raw || blocked > raw || topHosts.reduce((sum, host) => sum + host.count, 0) > attention) {
    return { kind: "degrade", reason: "aggregate_inconsistent" };
  }
  if (attention > 0) return { kind: "continue" };
  // Independent Adaptive counts are checked for conflicts, never subtracted or
  // treated as proof of exact coverage. The user accepts rare-event sampling loss.
  if (raw !== blocked || topHosts.length !== 0) return { kind: "degrade", reason: "aggregate_inconsistent" };
  return raw === 0 ? { kind: "raw_empty", reason: "raw_window_empty" }
    : { kind: "suppress", reason: "no_attention_events_observed" };
}
