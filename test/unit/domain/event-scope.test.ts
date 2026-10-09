import { describe, expect, it } from "vitest";
import { ATTENTION_SCOPE, ScopedDiscoverySchema, SuppressionDecisionSchema } from "../../../src/domain/event-scope";

const valid = { ...ATTENTION_SCOPE, rawTotalEvents: 100, zoneTotalEvents: 1, blockedTotalEvents: 99,
  countQuality: "estimated", rawActions: [{ action: "block", count: 99 }, { action: "allow", count: 1 }], topHosts: [{ host: "example.test", count: 1 }] };

describe("attention discovery boundary", () => {
  it.each(["rawTotalEvents", "zoneTotalEvents", "blockedTotalEvents", "policyId", "eventScope", "countQuality", "topHosts", "rawActions"])("requires %s", (key) => {
    const input = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));
    expect(ScopedDiscoverySchema.safeParse(input).success).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, null, "0"])("rejects invalid or unavailable counts %s", (count) => {
    expect(ScopedDiscoverySchema.safeParse({ ...valid, rawTotalEvents: count }).success).toBe(false);
  });
  it("preserves a missing Host as uncovered data, never substituting the Zone name", () => {
    expect(ScopedDiscoverySchema.parse({ ...valid, topHosts: [{ host: null, count: 1 }] }).topHosts).toEqual([{ host: null, count: 1 }]);
  });
  it("rejects duplicate hosts and oversized candidate lists", () => {
    expect(ScopedDiscoverySchema.safeParse({ ...valid, topHosts: [valid.topHosts[0], valid.topHosts[0]] }).success).toBe(false);
    expect(ScopedDiscoverySchema.safeParse({ ...valid, topHosts: Array.from({ length: 11 }, (_, i) => ({ host: `${String(i)}.test`, count: 0 })) }).success).toBe(false);
  });
  it("does not allow an all-blocked certainty claim as suppression reason", () => {
    expect(SuppressionDecisionSchema.safeParse({ kind: "suppress", reason: "all_blocked" }).success).toBe(false);
  });
});
