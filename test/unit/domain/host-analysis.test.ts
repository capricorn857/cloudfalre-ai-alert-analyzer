import { ATTENTION_SCOPE } from "../../../src/domain/event-scope";
import { attentionCounts } from "../../fixtures/blocked-events";
import { describe, expect, it } from "vitest";
import { HostCollectionSchema, ZoneDiscoverySchema } from "../../../src/domain/host-analysis";

describe("host collection contracts", () => {
  it("keeps failed collection distinct from observed zero", () => {
    const failed = { ...ATTENTION_SCOPE, hostId: "h0", host: "example.test", discoveryCount: 600,
      collectionStatus: "failed", hostTotalEvents: null, aggregates: null, samples: [],
      samplesStatus: "not_requested", errorCode: "cloudflare_timeout" };
    expect(HostCollectionSchema.safeParse(failed).success).toBe(true);
    expect(HostCollectionSchema.safeParse({ ...failed, hostTotalEvents: 0 }).success).toBe(false);
  });
  it("accepts unassigned discovery hosts but rejects duplicates and unsafe counts", () => {
    expect(ZoneDiscoverySchema.safeParse({ ...attentionCounts(10), topHosts: [{ host: null, count: 10 }] }).success).toBe(true);
    expect(ZoneDiscoverySchema.safeParse({ ...attentionCounts(10), topHosts: [{ host: "a.test", count: 5 }, { host: "a.test", count: 5 }] }).success).toBe(false);
    expect(ZoneDiscoverySchema.safeParse({ ...attentionCounts(Number.MAX_SAFE_INTEGER + 1), topHosts: [] }).success).toBe(false);
  });
});
