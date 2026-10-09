import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { queueMessage } from "../fixtures/domain";
import { validEnv } from "../fixtures/config";

const group = (key: string, value: string, count: number) => ({ count, dimensions: { [key]: value } });
afterEach(() => vi.restoreAllMocks());

async function consume(mode: "mixed" | "blocked" | "unknown" | "sample_blocked", throwLog = false) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line)); if (throwLog) throw new Error("log unavailable");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body !== "string") throw new Error("JSON required");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.includes("graphql")) {
      const query = String(body.query);
      if (query.includes("WafHostDiscovery")) return Promise.resolve(Response.json({ data: { viewer: { zones: [{
        rawTotal: [{ count: 1000 }], attentionTotal: mode === "blocked" || mode === "unknown" ? [] : [{ count: 4 }],
        rawActions: mode === "blocked" ? [group("action", "block", 1000)] : mode === "unknown" ? [group("action", "block", 999), { count: 1, dimensions: { action: null } }] : [group("action", "block", 996), group("action", "allow", 4)],
        // The unfiltered busiest Host is blocked.example.test; server-side filtering selects this one.
        topHosts: mode === "blocked" || mode === "unknown" ? [] : [group("clientRequestHTTPHost", "attention.example.test", 4)],
      }] } } }));
      expect(body.variables).toMatchObject({ host: "attention.example.test" });
      expect(query).toContain('action_neq: "block"');
      expect(query).not.toContain("source:");
      if (query.includes("WafHostSamples")) return Promise.resolve(Response.json({ data: { viewer: { zones: [{ samples: [{
        datetime: queueMessage.analysisWindow.start, action: mode === "sample_blocked" ? "block" : "allow", clientIP: "192.0.2.1",
        clientRequestHTTPHost: "attention.example.test", clientRequestPath: "/login", source: "firewallCustom", userAgent: "FixtureAgent",
      }] }] } } }));
      return Promise.resolve(Response.json({ data: { viewer: { zones: [{ total: [{ count: 4 }], topIps: [group("clientIP", "192.0.2.1", 2)],
        topPaths: [group("clientRequestPath", "/login", 4)], topCountries: [group("clientCountryName", "ZZ", 4)], topAsns: [group("clientAsn", "64512", 4)],
        actions: [group("action", "allow", 4)], sources: [group("source", "firewallCustom", 2), group("source", "firewallManaged", 2)],
      }] } } }));
    }
    if (url.includes("chat/completions")) return Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ schema_version: 3, hosts: [{
      host_id: "h0", risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] }, observations: [],
      recommendations: [{ kind: "manual_dashboard", evidence_ids: ["h0:ctx:0"] }],
    }] }) } }] }));
    return Promise.resolve(Response.json({ errcode: 0, errmsg: "ok" }));
  });
  const before = structuredClone(queueMessage);
  const message = { body: structuredClone(queueMessage), attempts: 2, ack: vi.fn(), retry: vi.fn() };
  await worker.queue?.({ queue: "test", messages: [message] } as unknown as MessageBatch, validEnv as unknown as CloudflareWorkerEnv, {} as ExecutionContext);
  expect(message.ack).toHaveBeenCalledOnce(); expect(message.retry).not.toHaveBeenCalled();
  expect(message.body).toEqual(before);
  for (const request of requests.filter((item) => item.url.includes("graphql"))) expect(request.body.variables).toMatchObject({ start: before.analysisWindow.start, end: before.analysisWindow.end });
  return { requests, logs: logs.join("\n") };
}

describe("suppression through real Workers bindings and Fetch mocks", () => {
  it.each([false, true])("observed blocked window uses only discovery and ack, logger throws=%s", async (throwLog) => {
    const { requests, logs } = await consume("blocked", throwLog);
    expect(requests).toHaveLength(1); expect(logs).toContain("alert_suppressed");
    expect(logs).toContain("no_attention_events_observed"); expect(logs).not.toContain("notification_sent");
  });
  it("mixed actions use attention denominator and do not let blocked Hosts occupy selection", async () => {
    const { requests } = await consume("mixed");
    expect(requests.filter((item) => item.url.includes("graphql"))).toHaveLength(3);
    const ai = requests.find((item) => item.url.includes("chat/completions"));
    expect(ai).toBeDefined();
    const text = JSON.stringify(ai?.body);
    expect(text).toContain("attention.example.test"); expect(text).not.toContain("blocked.example.test");
    expect(text).toContain('\\"totalEvents\\":4'); expect(text).not.toContain('\\"totalEvents\\":1000');
    const notification = requests.find((item) => item.url.includes("qyapi"));
    const body = notification?.body as { text: { content: string } };
    expect(body.text.content).toContain("已排除 action=block");
    expect(body.text.content).toContain("50.0%");
    expect(new TextEncoder().encode(body.text.content).byteLength).toBeLessThanOrEqual(2000);
  });
  it("unknown Action cannot become observed-zero suppression", async () => {
    const { requests, logs } = await consume("unknown");
    expect(requests).toHaveLength(2); expect(requests.some((item) => item.url.includes("chat/completions"))).toBe(false);
    expect(logs).not.toContain("alert_suppressed"); expect(logs).toContain("action_unknown");
    expect(JSON.stringify(requests[1]?.body)).toContain("处理动作未知");
  });
  it("block-only sample contamination cannot silence a positive remaining aggregate", async () => {
    const { requests, logs } = await consume("sample_blocked");
    expect(requests.some((item) => item.url.includes("qyapi"))).toBe(true);
    expect(logs).not.toContain("alert_suppressed"); expect(logs).toContain("host_collection_failed");
    expect(JSON.stringify(requests.at(-1)?.body)).toContain("样本采集失败");
  });
});
