import { attentionCounts } from "../../fixtures/blocked-events";
import { describe, expect, it, vi } from "vitest";
import { analyzeWafAlert } from "../../../src/analyzers/waf-analyzer";
import { queueMessage, rulesConfig, snapshot } from "../../fixtures/domain";
import { hostFromSnapshot } from "../../fixtures/host-analysis";
import { AppError } from "../../../src/observability/errors";

describe("analyzeWafAlert", () => {
  it("collects each selected Host once and computes its statistics", async () => {
    const discoverZone = vi.fn().mockResolvedValue({ ...attentionCounts(400), topHosts: [{ host: "example.test", count: 400 }] });
    const collectHostSnapshot = vi.fn().mockResolvedValue(hostFromSnapshot(snapshot));
    const result = await analyzeWafAlert(queueMessage, { discoverZone, collectHostSnapshot }, rulesConfig);
    expect(result).toMatchObject({ status: "success", incident: { hosts: [{ statistics: { totalEvents: 400, allowRatio: 87.5 }, ruleAttention: "HIGH" }] } });
    expect(discoverZone).toHaveBeenCalledOnce();
    expect(collectHostSnapshot).toHaveBeenCalledOnce();
    expect(collectHostSnapshot.mock.calls[0]?.[0]).toMatchObject({ zoneTag: queueMessage.alert.zoneTag, analysisWindow: queueMessage.analysisWindow, sampleLimit: 50 });
  });
  it("does not query hosts or manufacture statistics after empty discovery", async () => {
    const collectHostSnapshot = vi.fn();
    const result = await analyzeWafAlert(queueMessage, { discoverZone: vi.fn().mockResolvedValue({ ...attentionCounts(0), topHosts: [] }), collectHostSnapshot }, rulesConfig);
    expect(result).toMatchObject({ status: "empty", incident: { hosts: [], zone: { analyzedHostCount: 0, coverage: { ratio: null } } } });
    expect(collectHostSnapshot).not.toHaveBeenCalled();
  });
  it("preserves classified discovery failure without calling Host queries", async () => {
    const discoverZone = vi.fn().mockRejectedValue(new AppError("cloudflare_graphql_errors", "safe", false, undefined, { externalService: "cloudflare", failureKind: "service_error", durationMs: 17 }));
    const collectHostSnapshot = vi.fn();
    expect(await analyzeWafAlert(queueMessage, { discoverZone, collectHostSnapshot }, rulesConfig)).toMatchObject({ status: "collection_failed", errorCode: "cloudflare_graphql_errors", failure: { durationMs: 17 } });
    expect(collectHostSnapshot).not.toHaveBeenCalled();
  });
  it("retains discovery when every Host query fails", async () => {
    const result = await analyzeWafAlert(queueMessage, {
      discoverZone: vi.fn().mockResolvedValue({ ...attentionCounts(400), topHosts: [{ host: "example.test", count: 400 }] }),
      collectHostSnapshot: vi.fn().mockRejectedValue(new Error("SENSITIVE")),
    }, rulesConfig);
    expect(result).toMatchObject({ status: "partial", incident: { zone: { zoneTotalEvents: 400, failedHostCount: 1 }, hosts: [{ collection: { hostTotalEvents: null, collectionStatus: "failed" } }] } });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE");
  });
});
