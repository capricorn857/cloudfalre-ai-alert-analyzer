import { attentionCounts } from "../fixtures/blocked-events";
import { describe, expect, it, vi } from "vitest";
import { CloudflareGraphQLClient } from "../../src/clients/cloudflare-graphql";

const input = { zoneTag: "zone-test", analysisWindow: { start: "2026-09-24T00:00:00.000Z", end: "2026-09-24T00:31:00.000Z" }, sampleLimit: 50 };
const selected = { hostId: "h0", host: "example.test", discoveryCount: 600 };
const aggregate = { total: [{ count: 600 }], topIps: [{ count: 360, dimensions: { clientIP: "192.0.2.10" } }], topPaths: [{ count: 300, dimensions: { clientRequestPath: "/login" } }], topCountries: [{ count: 600, dimensions: { clientCountryName: "ZZ" } }], topAsns: [{ count: 600, dimensions: { clientAsn: "64512" } }], actions: [{ count: 600, dimensions: { action: "log" } }], sources: [{ count: 600, dimensions: { source: "waf" } }] };
const response = (zone: unknown) => new Response(JSON.stringify({ data: { viewer: { zones: [zone] } } }));

describe("host filtered GraphQL operations", () => {
  it("discovers hosts and queries each host using the unchanged window", async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ rawTotal: [{ count: 1000 }], attentionTotal: [{ count: 1000 }], rawActions: [{ count: 1000, dimensions: { action: "allow" } }], topHosts: [{ count: 600, dimensions: { clientRequestHTTPHost: "example.test" } }] }))
      .mockResolvedValueOnce(response(aggregate))
      .mockResolvedValueOnce(response({ samples: [] }));
    const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 0 });
    expect(await client.discoverZone(input)).toEqual({ ...attentionCounts(1000), topHosts: [{ host: "example.test", count: 600 }] });
    expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "success", hostTotalEvents: 600, aggregates: { topPaths: [{ value: "/login", count: 300 }] } });
    const bodies = fetchFn.mock.calls.map((call) => {
      const body = call[1]?.body;
      if (typeof body !== "string") throw new Error("Expected JSON request body");
      return JSON.parse(body) as { query: string; variables: Record<string, unknown> };
    });
    expect(bodies[0]?.query.match(/firewallEventsAdaptiveGroups\(/gu)).toHaveLength(4);
    expect(bodies[1]?.query.match(/firewallEventsAdaptiveGroups\(/gu)).toHaveLength(7);
    for (const body of bodies) expect(body.variables).toMatchObject({ zoneTag: input.zoneTag, start: input.analysisWindow.start, end: input.analysisWindow.end });
    for (const body of bodies.slice(1)) expect(body.variables.host).toBe("example.test");
    expect(bodies[2]?.query).toContain("$sampleLimit: uint64!");
    expect(bodies[1]?.query).toContain("clientRequestHTTPHost: $host");
  });
  it("preserves aggregates on sample failure and does not disguise failure as zero", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(aggregate)).mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 0 });
    expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "partial", hostTotalEvents: 600, samplesStatus: "failed" });
    fetchFn.mockReset().mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "failed", hostTotalEvents: null, samplesStatus: "not_requested" });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
  it("rejects samples assigned to a different host", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(aggregate)).mockResolvedValueOnce(response({ samples: [{ datetime: input.analysisWindow.start, action: "log", clientIP: "192.0.2.10", clientRequestHTTPHost: "other.test" }] }));
    const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 0 });
    expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "partial", samplesStatus: "failed", samples: [] });
  });
  it("does not issue a request after the shared deadline", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 2 });
    expect(await client.collectHostSnapshot({ ...input, deadlineAt: Date.now() - 1 }, selected)).toMatchObject({ collectionStatus: "failed", errorCode: "collection_budget_exhausted" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("aborts a hanging response body at the shared deadline without retrying", async () => {
    vi.useFakeTimers();
    try {
      const cancelled = vi.fn();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel: cancelled })));
      const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 2 });
      const result = client.collectHostSnapshot({ ...input, deadlineAt: Date.now() + 20 }, selected);
      await vi.advanceTimersByTimeAsync(25);
      expect(await result).toMatchObject({ collectionStatus: "failed", errorCode: "collection_budget_exhausted" });
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each([401, 429, 503])("limits HTTP %i attempts and preserves filter variables", async (status) => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response("{}", { status })));
    const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 2, sleep: () => Promise.resolve() });
    expect(await client.collectHostSnapshot(input, selected)).toMatchObject({ collectionStatus: "failed", hostTotalEvents: null });
    expect(fetchFn).toHaveBeenCalledTimes(status === 401 ? 1 : 3);
    expect(new Set(fetchFn.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
  });
  it("does not let retry backoff extend the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(new Response("{}", { status: 503 })));
      const client = new CloudflareGraphQLClient({ token: "test", fetchFn, timeoutMs: 1000, retries: 2 });
      let settled = false;
      const result = client.collectHostSnapshot({ ...input, deadlineAt: Date.now() + 150 }, selected).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(150);
      expect(settled).toBe(true);
      expect(await result).toMatchObject({ errorCode: "collection_budget_exhausted" });
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
});
