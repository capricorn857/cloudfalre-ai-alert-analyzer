import { describe, expect, it, vi } from "vitest";
import { CloudflareGraphQLClient } from "../../src/clients/cloudflare-graphql";
const input = { zoneTag: "test", analysisWindow: { start: "2026-10-09T00:00:00Z", end: "2026-10-09T00:31:00Z" }, sampleLimit: 50 };
const selected = { hostId: "h0", host: "example.test", discoveryCount: 2 };
const response = (zone: unknown) => new Response(JSON.stringify({ data: { viewer: { zones: [zone] } } }));
const discovery = { rawTotal: [{ count: 10 }], attentionTotal: [{ count: 3 }], rawActions: [{ count: 6, dimensions: { action: "block" } }, { count: 4, dimensions: { action: "challenge" } }], topHosts: [] };
const aggregate = { total: [{ count: 2 }], topIps: [], topPaths: [], topCountries: [], topAsns: [], actions: [{ count: 2, dimensions: { action: "challenge" } }], sources: [] };
const requestQuery = (body: unknown): string => {
 if (typeof body !== "string") throw new Error("Expected JSON body");
 return (JSON.parse(body) as { query: string }).query;
};
const clientFor = (...zones: unknown[]) => {
 const fetchFn = vi.fn<typeof fetch>();
 for (const zone of zones) fetchFn.mockResolvedValueOnce(response(zone));
 return { fetchFn, client: new CloudflareGraphQLClient({ token: "test", fetchFn, retries: 0, timeoutMs: 1000 }) };
};
describe("exact block scoped GraphQL", () => {
 it("uses four guard aliases and independent estimated block counts", async () => {
  const { client, fetchFn } = clientFor(discovery);
  expect(await client.discoverZone(input)).toMatchObject({ eventScope: "attention", rawTotalEvents: 10, zoneTotalEvents: 3, blockedTotalEvents: 6, countQuality: "estimated" });
  const body = { query: requestQuery(fetchFn.mock.calls[0]?.[1]?.body) };
  expect(body.query.match(/firewallEventsAdaptiveGroups\(/gu)).toHaveLength(4);
  expect(body.query.match(/action_neq: "block"/gu)).toHaveLength(2);
 });
 it.each(["rawTotal", "attentionTotal", "rawActions", "topHosts"])("rejects missing mandatory %s", async (alias) => {
  const zone = Object.fromEntries(Object.entries(discovery).filter(([key]) => key !== alias));
  await expect(clientFor(zone).client.discoverZone(input)).rejects.toMatchObject({ code: "cloudflare_response_invalid" });
 });
 it("accepts verified empty totals and preserves unknown actions", async () => {
  expect(await clientFor({ ...discovery, rawTotal: [], attentionTotal: [], rawActions: [{ count: 0, dimensions: {} }] }).client.discoverZone(input)).toMatchObject({ rawTotalEvents: 0, zoneTotalEvents: 0, rawActions: [{ action: null, count: 0 }] });
 });
 it.each([null, "10", Number.MAX_SAFE_INTEGER + 1])("rejects invalid count %s", async (count) => {
  await expect(clientFor({ ...discovery, rawTotal: [{ count }] }).client.discoverZone(input)).rejects.toMatchObject({ code: "cloudflare_response_invalid" });
 });
 it("does not derive block count when categories truncate or duplicate", async () => {
  const rawActions = Array.from({ length: 20 }, (_, i) => ({ count: i === 0 ? 10 : 0, dimensions: { action: String(i) } }));
  expect(await clientFor({ ...discovery, rawActions }).client.discoverZone(input)).toMatchObject({ blockedTotalEvents: null });
  expect(await clientFor({ ...discovery, rawActions: [discovery.rawActions[0], discovery.rawActions[0]] }).client.discoverZone(input)).toMatchObject({ blockedTotalEvents: null });
 });
 it.each([null, undefined, "", "Block", "challenge"])("filters every host node and preserves sample action %s", async (action) => {
  const { client, fetchFn } = clientFor(aggregate, { samples: [{ datetime: input.analysisWindow.start, action, clientIP: "192.0.2.1", clientRequestHTTPHost: selected.host }] });
  expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ eventScope: "attention", samplesStatus: "success", samples: [{ action: action == null || action === "" ? "unknown" : action }] });
  for (const [index, call] of fetchFn.mock.calls.entries()) {
   const body = { query: requestQuery(call[1]?.body) };
   expect(body.query.match(/action_neq: "block"/gu)).toHaveLength(index === 0 ? 7 : 1);
  }
 });
 it("retains nullish aggregate action as unknown and does not exclude rules or source", async () => {
  const { client, fetchFn } = clientFor({ ...aggregate, actions: [{ count: 2, dimensions: {} }] }, { samples: [] });
  expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ aggregates: { actions: [{ value: "unknown", count: 2 }] } });
  const query = requestQuery(fetchFn.mock.calls[0]?.[1]?.body);
  expect(query).not.toMatch(/source_neq|ruleId_neq|clientIP_neq/u);
 });
 it.each([null, { ...discovery, rawTotal: null }, { ...discovery, rawActions: [{ count: 1, dimensions: { action: 12 } }] }])("rejects malformed discovery protocol", async (zone) => {
  await expect(clientFor(zone).client.discoverZone(input)).rejects.toMatchObject({ code: "cloudflare_response_invalid" });
 });
 it("fails contaminated aggregates before requesting samples", async () => {
  const { client, fetchFn } = clientFor({ ...aggregate, actions: [{ count: 2, dimensions: { action: "block" } }] });
  expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ eventScope: "attention", collectionStatus: "failed", errorCode: "cloudflare_response_invalid" });
  expect(fetchFn).toHaveBeenCalledOnce();
 });
 it("rejects the whole contaminated sample set while retaining aggregates", async () => {
  const { client } = clientFor(aggregate, { samples: [{ datetime: input.analysisWindow.start, action: "block", clientIP: "192.0.2.1", clientRequestHTTPHost: selected.host }] });
  expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "partial", hostTotalEvents: 2, samplesStatus: "failed", samples: [] });
 });
});
