import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { queueMessage } from "../fixtures/domain";
import { validEnv } from "../fixtures/config";

const group = (key: string, value: string, count: number) => ({ count, dimensions: { [key]: value } });
afterEach(() => vi.restoreAllMocks());

type Mode = "mixed" | "blocked" | "unknown" | "sample_blocked" | "blocked_mismatch" | "mixed_mismatch" | "zero_zone" | "unknown_hosts" | "missing_action_hosts" | "empty_action_hosts" | "truncated_hosts" | "nonblock_no_hosts" | "raw_empty" | "graphql_errors" | "missing_alias";

async function consume(mode: Mode, throwLog = false, retryNotification = false) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  let notifications = 0;
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
      if (query.includes("WafHostDiscovery")) {
        if (mode === "graphql_errors") return Promise.resolve(Response.json({ data: { viewer: { zones: [] } }, errors: [{ message: "fixture query failure" }] }));
        const blocked = mode === "blocked" || mode === "blocked_mismatch";
        const unknown = ["unknown", "unknown_hosts", "missing_action_hosts", "empty_action_hosts"].includes(mode);
        const rawActions = blocked ? [group("action", "block", mode === "blocked_mismatch" ? 1362 : 1000)]
          : unknown ? [group("action", "block", 996), { count: 4, dimensions: mode === "missing_action_hosts" ? {} : { action: mode === "empty_action_hosts" ? "" : null } }]
          : mode === "truncated_hosts" ? Array.from({ length: 20 }, (_, i) => group("action", "fixture_action_" + String(i), 50))
          : mode === "raw_empty" ? [] : [group("action", "block", 996), group("action", "allow", 4)];
        const zone: Record<string, unknown> = {
          rawTotal: mode === "raw_empty" ? [] : [{ count: mode === "blocked_mismatch" ? 1360 : mode === "mixed_mismatch" ? 1002 : 1000 }],
          attentionTotal: blocked || ["unknown", "zero_zone", "raw_empty", "nonblock_no_hosts"].includes(mode) ? [] : [{ count: 4 }], rawActions,
          topHosts: blocked || ["unknown", "raw_empty", "nonblock_no_hosts"].includes(mode) ? [] : [group("clientRequestHTTPHost", "attention.example.test", 4)],
        };
        if (mode === "missing_alias") delete zone.attentionTotal;
        return Promise.resolve(Response.json({ data: { viewer: { zones: [zone] } } }));
      }
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
    notifications++;
    if (retryNotification && notifications === 1) return Promise.resolve(new Response("temporary", { status: 503 }));
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

describe("aggregate quality decisions through the real Worker", () => {
  it("silences all-block positive estimate differences", async () => {
    const { requests, logs } = await consume("blocked_mismatch");
    expect(requests).toHaveLength(1);
    expect(logs).toContain("raw_action_sum_mismatch");
    expect(logs).toContain('"final_decision":"suppressed"');
  });
  it.each(["mixed_mismatch", "zero_zone", "unknown_hosts", "missing_action_hosts", "empty_action_hosts", "truncated_hosts"] as const)("preserves reliable Host details for %s", async (mode) => {
    const { requests, logs } = await consume(mode);
    expect(requests.filter((item) => item.url.includes("graphql"))).toHaveLength(3);
    expect(requests.filter((item) => item.url.includes("chat/completions"))).toHaveLength(1);
    const text = (requests.find((item) => item.url.includes("qyapi"))?.body as {text: {content: string}}).text.content;
    expect(text).toContain("Host: attention.example.test");
    expect(text).toContain("来源 IP:");
    expect(text).toContain("已排除 action=block");
    expect(logs).not.toContain("alert_suppressed");
    if (mode !== "mixed_mismatch") expect(text).toContain("占 Zone 未知");
    if (mode.includes("action") || mode.includes("unknown") || mode.includes("truncated")) expect(text).toContain("未知范围未被可靠覆盖");
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(2000);
  });
  it.each(["nonblock_no_hosts", "raw_empty", "graphql_errors", "missing_alias"] as const)("distinguishes facts without hosts from empty and failed %s", async (mode) => {
    const { requests, logs } = await consume(mode);
    expect(requests.some((item) => item.url.includes("chat/completions"))).toBe(false);
    expect(logs).not.toContain("alert_suppressed");
    const text = (requests.find((item) => item.url.includes("qyapi"))?.body as {text: {content: string}}).text.content;
    expect(text).toContain("分析窗口:");
    expect(text).toContain("correlation_id:");
    if (mode === "nonblock_no_hosts") { expect(text).toContain("未取得可用Host明细"); expect(text).toContain("原始上下文"); }
    else if (mode === "raw_empty") expect(text).toContain("数据不足");
    else { expect(text).toContain("数据采集失败"); expect(text).not.toContain("待关注事件（已排除 action=block）: 0"); }
  });
  it("retries notification with identical bytes and no repeated analysis", async () => {
    const { requests } = await consume("mixed_mismatch", false, true);
    expect(requests.filter((item) => item.url.includes("graphql"))).toHaveLength(3);
    expect(requests.filter((item) => item.url.includes("chat/completions"))).toHaveLength(1);
    const notifications = requests.filter((item) => item.url.includes("qyapi"));
    expect(notifications).toHaveLength(2);
    expect(notifications[0]?.body).toEqual(notifications[1]?.body);
  });
  it("acks sent Host notification despite logging failures", async () => {
    const { requests } = await consume("mixed_mismatch", true);
    expect(requests.filter((item) => item.url.includes("qyapi"))).toHaveLength(1);
  });
});
