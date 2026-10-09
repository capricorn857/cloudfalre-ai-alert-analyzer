import type { ZoneDiscovery } from "../../../src/domain/host-analysis";
import { attentionCounts } from "../../fixtures/blocked-events";
import { describe, expect, it, vi } from "vitest";
import { analyzeHostWafAlert } from "../../../src/analyzers/waf-analyzer";
import { queueMessage, rulesConfig } from "../../fixtures/domain";
import { makeHost } from "../../fixtures/host-analysis";

describe("host WAF orchestration", () => {
  it("keeps one window, two concurrency slots and host failures isolated", async () => {
    let active = 0;
    let maximum = 0;
    const client = {
      discoverZone: vi.fn().mockResolvedValue({ ...attentionCounts(1200), topHosts: [
        { host: "example.test", count: 600 }, { host: "www.example.test", count: 300 }, { host: "api.example.test", count: 200 },
      ] }),
      collectHostSnapshot: vi.fn(async (_input: unknown, selected: { hostId: string; host: string; discoveryCount: number }) => {
        active++; maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        if (selected.hostId === "h1") throw new Error("mock failure");
        return makeHost(selected.hostId, selected.host, selected.discoveryCount);
      }),
    };
    const result = await analyzeHostWafAlert(queueMessage, client, rulesConfig);
    expect(result.status).toBe("partial");
    if (!("incident" in result)) throw new Error("unexpected discovery failure");
    expect(result.incident.hosts).toHaveLength(3);
    expect(result.incident.hosts[1]?.collection.collectionStatus).toBe("failed");
    expect(maximum).toBeLessThanOrEqual(2);
    expect(client.discoverZone).toHaveBeenCalledOnce();
    for (const [input] of client.collectHostSnapshot.mock.calls) expect(input).toMatchObject({ analysisWindow: queueMessage.analysisWindow, zoneTag: queueMessage.alert.zoneTag, sampleLimit: queueMessage.configSnapshot.sampleLimit });
    expect(new Set(client.collectHostSnapshot.mock.calls.map(([input]) => (input as { deadlineAt: number }).deadlineAt)).size).toBe(1);
  });
  it("does not collect hosts for a zero-event discovery", async () => {
    const client = { discoverZone: vi.fn().mockResolvedValue({ ...attentionCounts(0), topHosts: [] }), collectHostSnapshot: vi.fn() };
    expect(await analyzeHostWafAlert(queueMessage, client, rulesConfig)).toMatchObject({ status: "empty", incident: { zone: { coverage: { ratio: null, status: "empty" } }, hosts: [] } });
    expect(client.collectHostSnapshot).not.toHaveBeenCalled();
  });
  it("isolates a fulfilled but misassigned Host result", async () => {
    const result = await analyzeHostWafAlert(queueMessage, {
      discoverZone: () => Promise.resolve({ ...attentionCounts(1000), topHosts: [{ host: "example.test", count: 600 }, { host: "www.example.test", count: 300 }] }),
      collectHostSnapshot: (_input, selected) => Promise.resolve(selected.hostId === "h0" ? makeHost("h1", "www.example.test", 300) : makeHost(selected.hostId, selected.host, selected.discoveryCount)),
    }, rulesConfig);
    expect(result).toMatchObject({ status: "partial", incident: { hosts: [{ collection: { hostId: "h0", collectionStatus: "failed" } }, { collection: { hostId: "h1", collectionStatus: "success" } }] } });
  });
});

it.each(["raw_difference", "zero_zone", "unknown", "truncated"])("retains two reliable Hosts with %s discovery quality", async (kind) => {
  const discovery: ZoneDiscovery = { ...attentionCounts(900), topHosts: [{ host: "example.test", count: 600 }, { host: "www.example.test", count: 300 }] };
  if (kind === "raw_difference") discovery.rawTotalEvents = 800;
  if (kind === "zero_zone") discovery.zoneTotalEvents = 0;
  if (kind === "unknown") discovery.rawActions.push({ action: null, count: 1 });
  if (kind === "truncated") discovery.rawActions = Array.from({ length: 20 }, (_, i) => ({ action: String(i), count: 45 }));
  const client = { discoverZone: vi.fn().mockResolvedValue(discovery), collectHostSnapshot: vi.fn((_input: unknown, selected: {hostId: string; host: string; discoveryCount: number}) => Promise.resolve(makeHost(selected.hostId, selected.host, selected.discoveryCount))) };
  const result = await analyzeHostWafAlert(queueMessage, client, rulesConfig);
  expect(client.collectHostSnapshot).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({status: "partial", quality: {reasonCodes: expect.any(Array) as unknown}, incident: {hosts: [{collection: {hostId: "h0"}}, {collection: {hostId: "h1"}}]}});
  if (kind !== "raw_difference" && "incident" in result) expect(result.incident.zone.coverage.ratio).toBeNull();
});
