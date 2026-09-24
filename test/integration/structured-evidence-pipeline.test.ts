import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { calculateStatistics } from "../../src/analysis/statistics";
import { evaluateRules } from "../../src/analysis/rules";
import { queueMessage } from "../fixtures/domain";
import { validEnv } from "../fixtures/config";
import aggregateSuccess from "../fixtures/graphql/aggregate-success.json";
import samplesSuccess from "../fixtures/graphql/samples-success.json";
import validOutput from "../fixtures/llm/valid-output.json";

vi.mock("../../src/analysis/statistics", { spy: true });
vi.mock("../../src/analysis/rules", { spy: true });
afterEach(() => vi.restoreAllMocks());

async function consume(content: string, options: { transientLlm?: boolean; insufficient?: boolean; longContext?: boolean; empty?: boolean; transientSend?: boolean } = {}) {
  vi.mocked(calculateStatistics).mockClear();
  vi.mocked(evaluateRules).mockClear();
  const aggregate = structuredClone(aggregateSuccess);
  const zone = aggregate.data.viewer.zones[0];
  if (zone === undefined) throw new Error("fixture");
  if (options.insufficient) zone.topCountries = [];
  if (options.empty) {
    zone.total = [{ count: 0 }]; zone.topIps = []; zone.topPaths = []; zone.topCountries = [];
    zone.topAsns = []; zone.topHosts = []; zone.actions = []; zone.sources = [];
  }
  const counts = { graphql: 0, llm: 0, wecom: 0 };
  const messages: string[] = [];
  const windows: unknown[] = [];
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (typeof init?.body !== "string") throw new Error("Expected JSON request");
    if (target.includes("api.cloudflare.com")) {
      counts.graphql++;
      const body = JSON.parse(init.body) as { variables: unknown };
      windows.push(body.variables);
      return Promise.resolve(Response.json(counts.graphql === 1 ? aggregate : samplesSuccess));
    }
    if (target.includes("llm.example.test")) {
      counts.llm++;
      if (options.transientLlm && counts.llm === 1) return Promise.resolve(new Response("busy", { status: 429 }));
      return Promise.resolve(Response.json({ choices: [{ finish_reason: "stop", message: { content } }] }));
    }
    if (target.includes("qyapi.weixin.qq.com")) {
      counts.wecom++;
      const body = JSON.parse(init.body) as { text: { content: string } };
      messages.push(body.text.content);
      if (options.transientSend && counts.wecom === 1) return Promise.resolve(new Response("busy", { status: 503 }));
      return Promise.resolve(Response.json({ errcode: 0, errmsg: "ok" }));
    }
    throw new Error("Unexpected test request");
  });
  const body = structuredClone(queueMessage);
  if (options.longContext) body.alert.resource = "x".repeat(2049);
  const before = structuredClone(body.analysisWindow);
  const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await worker.queue?.({ queue: "test", messages: [message] } as unknown as MessageBatch, validEnv as unknown as CloudflareWorkerEnv, {} as ExecutionContext);
  expect(counts.graphql).toBe(2);
  expect(calculateStatistics).toHaveBeenCalledOnce();
  expect(evaluateRules).toHaveBeenCalledOnce();
  expect(message.ack).toHaveBeenCalledOnce();
  expect(message.retry).not.toHaveBeenCalled();
  expect(body.analysisWindow).toEqual(before);
  for (const window of windows) expect(window).toMatchObject({ start: before.start, end: before.end });
  return { counts, messages, logs: logs.join("\n") };
}

describe("structured evidence failure isolation in Workers", () => {
  const cases = [
    ["not JSON", "llm_output_not_json"],
    [JSON.stringify({ ...validOutput, summary: "MODEL_SENTINEL" }), "llm_output_schema_invalid"],
    [JSON.stringify({ ...validOutput, attack: { type: "Unknown", confidence: 0, evidence_ids: ["unknown:sentinel"] } }), "ai_reference_invalid"],
    [JSON.stringify({ ...validOutput, risk: { level: "HIGH", evidence_ids: ["stat:allow", "stat:allow"] } }), "ai_reference_invalid"],
    [JSON.stringify({ ...validOutput, risk: { level: "HIGH", evidence_ids: ["sample:0", "finding:allow_ratio", "stat:allow"] } }), "ai_reference_type_mismatch"],
    [JSON.stringify({ ...validOutput, risk: { level: "HIGH", evidence_ids: ["quality:0", "stat:allow"] } }), "ai_claim_unsupported"],
    [JSON.stringify({ ...validOutput, attack: { type: "Brute Force", confidence: 0.5, evidence_ids: ["stat:path"] } }), "ai_claim_unsupported"],
  ];
  it.each(cases)("isolates output %s", async (content, code) => {
    const result = await consume(content);
    expect(result.counts).toEqual({ graphql: 2, llm: 1, wecom: 1 });
    expect(result.logs).toContain(code);
    expect(result.logs).not.toContain("MODEL_SENTINEL");
    expect(result.logs).not.toContain("unknown:sentinel");
    expect(result.messages[0]).toContain("AI 分析暂不可用");
  });
  it("rejects definite risk with partial statistics", async () => {
    const result = await consume(JSON.stringify(validOutput), { insufficient: true });
    expect(result.logs).toContain("ai_data_insufficient");
    expect(result.counts).toEqual({ graphql: 2, llm: 1, wecom: 1 });
  });
  it.each([{ longContext: true }, { empty: true }])("skips the LLM for local failures or empty data %j", async (options) => {
    const result = await consume(JSON.stringify(validOutput), options);
    expect(result.counts).toEqual({ graphql: 2, llm: 0, wecom: 1 });
    if ("longContext" in options) {
      expect(result.logs).toContain("analysis_failed");
      expect(result.logs).not.toContain('"external_service":"llm"');
    }
  });
  it("keeps transient LLM and send retries within their stages", async () => {
    const result = await consume(JSON.stringify({ ...validOutput, summary: "MODEL_SENTINEL" }), { transientLlm: true, transientSend: true });
    expect(result.counts).toEqual({ graphql: 2, llm: 2, wecom: 2 });
    expect(result.messages[0]).toEqual(result.messages[1]);
  });
});
