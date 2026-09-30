import { afterEach, describe, expect, it, vi } from "vitest";
import { processHostAlert } from "../../src/pipeline/process-alert";
import { createProcessAlertDependencies } from "../../src/config/dependencies";
import { parseEnv } from "../../src/config/env";
import { queueMessage } from "../fixtures/domain";
import { validEnv } from "../fixtures/config";

afterEach(() => vi.unstubAllGlobals());
const json = (value: unknown) => new Response(JSON.stringify(value));
describe("Host pipeline in Workers", () => {
  it("uses seven GraphQL requests, one LLM and one notification for three hosts", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body });
      if (url.includes("graphql")) {
        const query = String(body.query);
        if (query.includes("WafHostDiscovery")) return Promise.resolve(json({ data: { viewer: { zones: [{ total: [{ count: 1000 }], topHosts: [0, 1, 2].map((i) => ({ count: 300, dimensions: { clientRequestHTTPHost: `h${String(i)}.example.test` } })) }] } } }));
        if (query.includes("WafHostSamples")) return Promise.resolve(json({ data: { viewer: { zones: [{ samples: [] }] } } }));
        return Promise.resolve(json({ data: { viewer: { zones: [{ total: [{ count: 300 }], topIps: [{ count: 200, dimensions: { clientIP: "192.0.2.10" } }], topPaths: [{ count: 200, dimensions: { clientRequestPath: "/login" } }], topCountries: [{ count: 300, dimensions: { clientCountryName: "ZZ" } }], topAsns: [{ count: 300, dimensions: { clientAsn: "64512" } }], actions: [{ count: 300, dimensions: { action: "block" } }], sources: [{ count: 300, dimensions: { source: "waf" } }] }] } } }));
      }
      if (url.includes("chat/completions")) return Promise.resolve(json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ schema_version: 3, hosts: [0, 1, 2].map((i) => ({ host_id: `h${String(i)}`, risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] }, observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: [`h${String(i)}:ctx:0`] }] })) }) } }] }));
      return Promise.resolve(json({ errcode: 0, errmsg: "ok" }));
    }));
    const deps = createProcessAlertDependencies(parseEnv(validEnv));
    const result = await processHostAlert(queueMessage, deps);
    expect(result).toMatchObject({ status: "sent", snapshotStatus: "success", aiStatus: "available" });
    expect(calls.filter((call) => call.url.includes("graphql"))).toHaveLength(7);
    expect(calls.filter((call) => call.url.includes("chat/completions"))).toHaveLength(1);
    expect(calls).toHaveLength(9);
    const notification = calls[8]?.body as { text: { content: string } };
    expect(notification.text.content).toContain("事件覆盖估计 90.0%");
    expect(new TextEncoder().encode(notification.text.content).byteLength).toBeLessThanOrEqual(2000);
  });
});
