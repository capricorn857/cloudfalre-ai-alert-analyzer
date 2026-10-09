import { describe, expect, it } from "vitest";
import { decideSuppression } from "../../../src/analysis/suppression";
import { ScopedDiscoverySchema } from "../../../src/domain/event-scope";

const discovery = (rawTotalEvents: number, zoneTotalEvents: number, blockedTotalEvents: number) => ({
  policyId: "exclude-exact-block-v1" as const, eventScope: "attention" as const,
  rawTotalEvents, zoneTotalEvents, blockedTotalEvents, countQuality: "estimated" as const,
  rawActions: [...(blockedTotalEvents > 0 ? [{ action: "block", count: blockedTotalEvents }] : []), ...(zoneTotalEvents > 0 ? [{ action: "allow", count: zoneTotalEvents }] : [])],
  topHosts: [],
});

describe("observed attention suppression", () => {
  it.each([null, ""])("degrades unknown raw Action %s rather than assuming it is filtered safely", (action) => {
    expect(decideSuppression({ ...discovery(100, 1, 99), rawActions: [{ action: "block", count: 99 }, { action, count: 1 }] })).toMatchObject({ kind: "degrade", reason: "action_unknown" });
  });
  it("detects unknown events lost by the negation query", () => {
    expect(decideSuppression({ ...discovery(100, 0, 100), rawActions: [{ action: "block", count: 99 }, { action: null, count: 1 }] }).kind).toBe("degrade");
  });
  it("degrades a truncated unfiltered Action distribution", () => {
    expect(decideSuppression({ ...discovery(100, 0, 100), rawActions: Array.from({ length: 20 }, (_, i) => ({ action: String(i), count: 5 })) }).kind).toBe("degrade");
  });
  it("keeps unrecognized but nonempty Action strings and exact case variants", () => {
    for (const action of ["future_action", "BLOCK", "block "]) expect(decideSuppression({ ...discovery(100, 1, 99), rawActions: [{ action: "block", count: 99 }, { action, count: 1 }] }).kind).toBe("continue");
  });
  it("accepts an internally consistent Adaptive zero without claiming all requests blocked", () => {
    expect(decideSuppression(discovery(100, 0, 100))).toEqual({ kind: "suppress", reason: "no_attention_events_observed" });
  });
  it("distinguishes original empty from filtered empty", () => {
    expect(decideSuppression(discovery(0, 0, 0))).toEqual({ kind: "raw_empty", reason: "raw_window_empty" });
  });
  it.each([[100, 1, 99], [10000, 1, 9999]])("never suppresses a positive aggregate even with no selected hosts", (raw, attention, blocked) => {
    expect(decideSuppression(discovery(raw, attention, blocked)).kind).toBe("continue");
  });
  it.each([[100, 0, 99], [0, 1, 0], [100, 101, 0], [100, 0, 101]])("degrades contradictory counts", (raw, attention, blocked) => {
    expect(decideSuppression(discovery(raw, attention, blocked)).kind).toBe("degrade");
  });
  it("does not silence when zero contradicts discovery evidence", () => {
    expect(decideSuppression({ ...discovery(100, 0, 100), topHosts: [{ host: "example.test", count: 1 }] }).kind).toBe("degrade");
  });
  it("requires an empty ranking even if all returned host counts are zero", () => {
    expect(decideSuppression({ ...discovery(100, 0, 100), topHosts: [{ host: "example.test", count: 0 }] }).kind).toBe("degrade");
  });
  it("requires every count and explicit scope instead of defaulting missing data", () => {
    const missing = Object.fromEntries(Object.entries(discovery(100, 0, 100)).filter(([key]) => key !== "rawTotalEvents"));
    expect(ScopedDiscoverySchema.safeParse(missing).success).toBe(false);
    expect(ScopedDiscoverySchema.safeParse({ ...discovery(100, 0, 100), eventScope: "raw" }).success).toBe(false);
  });
});
