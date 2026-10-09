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
  it.each([[100,100], [1360,1362], [100,99], [100,101]])("suppresses only-block observations despite independent positive estimates %s/%s", (raw, block) => {
    expect(decideSuppression(discovery(raw, 0, block))).toMatchObject({ kind: "suppress", reason: "no_attention_events_observed" });
  });
  it("distinguishes a valid raw-empty window", () => {
    expect(decideSuppression(discovery(0, 0, 0))).toMatchObject({ kind: "raw_empty", reason: "raw_window_empty" });
  });
  it.each([null, ""])("retains valid hosts with unknown original Action %s", (action) => {
    const result = decideSuppression({ ...discovery(100, 1, 99), rawActions: [{ action: "block", count: 99 }, { action, count: 1 }], topHosts: [{ host: "example.test", count: 1 }] });
    expect(result).toMatchObject({ kind: "continue", quality: { zoneDenominatorComparable: false, reasonCodes: expect.arrayContaining(["action_unknown"]) as unknown } });
  });
  it.each(["future_action", "BLOCK", "block "])("retains exact non-block Action %s", (action) => {
    expect(decideSuppression({ ...discovery(100, 1, 99), rawActions: [{ action: "block", count: 99 }, { action, count: 1 }], topHosts: [{ host: "example.test", count: 1 }] }).kind).toBe("continue");
  });
  it("retains hosts at zero attention total and disables the denominator", () => {
    expect(decideSuppression({ ...discovery(100, 0, 100), topHosts: [{ host: "example.test", count: 1 }] })).toMatchObject({ kind: "continue", quality: { zoneDenominatorComparable: false, reasonCodes: expect.arrayContaining(["attention_zero_positive_host"]) as unknown } });
  });
  it("does not let raw estimation differences disable comparable filtered data", () => {
    expect(decideSuppression({ ...discovery(99, 10, 100), topHosts: [{ host: "example.test", count: 10 }] })).toMatchObject({ kind: "continue", quality: { zoneDenominatorComparable: true, reasonCodes: expect.arrayContaining(["raw_action_sum_mismatch"]) as unknown } });
  });
  it("retains hosts when original actions truncate", () => {
    expect(decideSuppression({ ...discovery(100, 10, 90), blockedTotalEvents: null, rawActions: Array.from({ length: 20 }, (_, i) => ({ action: String(i), count: 5 })), topHosts: [{ host: "example.test", count: 10 }] })).toMatchObject({ kind: "continue", quality: { zoneDenominatorComparable: false } });
  });
  it("reports non-block evidence without usable hosts", () => {
    expect(decideSuppression(discovery(100, 1, 99))).toMatchObject({ kind: "degrade", reason: "no_usable_hosts" });
  });
  it.each([
    { ...discovery(100, 0, 99), rawActions: [{ action: "block", count: 99 }, { action: null, count: 1 }] },
    { ...discovery(100, 0, 100), rawActions: [] },
    { ...discovery(0, 0, 1) },
    { ...discovery(100, 0, 100), topHosts: [{ host: "example.test", count: 0 }] },
    { ...discovery(100, 0, 100), rawActions: Array.from({ length: 20 }, () => ({ action: "block", count: 5 })) },
  ])("never suppresses semantic conflicts or incomplete evidence", (input) => {
    expect(decideSuppression(input).kind).toBe("degrade");
  });
  it("requires explicit fields and rejects unsafe sums", () => {
    const missing = Object.fromEntries(Object.entries(discovery(100, 0, 100)).filter(([key]) => key !== "rawTotalEvents"));
    expect(ScopedDiscoverySchema.safeParse(missing).success).toBe(false);
    expect(ScopedDiscoverySchema.safeParse({ ...discovery(100, 0, 100), eventScope: "raw" }).success).toBe(false);
    expect(ScopedDiscoverySchema.safeParse({ ...discovery(1, 0, 1), rawActions: [{action: "block", count: Number.MAX_SAFE_INTEGER}, {action: "allow", count: 1}] }).success).toBe(false);
  });
});
