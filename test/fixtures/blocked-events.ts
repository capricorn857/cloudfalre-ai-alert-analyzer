import { ATTENTION_SCOPE } from "../../src/domain/event-scope";

/** Synthetic all-attention counts for existing Host tests; never a production fallback. */
export function attentionCounts(total: number) {
  return { ...ATTENTION_SCOPE, rawTotalEvents: total, zoneTotalEvents: total, blockedTotalEvents: 0,
    countQuality: "estimated" as const, rawActions: total > 0 ? [{ action: "allow", count: total }] : [] };
}
