import { describe, expect, it, vi } from "vitest";
import { processHostAlert } from "../../src/pipeline/process-alert";
import { handleQueueBatch } from "../../src/pipeline/queue-handler";
import { queueMessage, rulesConfig } from "../fixtures/domain";
import { ATTENTION_SCOPE } from "../../src/domain/event-scope";

const discovered = (raw = 100, attention = 0, blocked = 100) => ({ ...ATTENTION_SCOPE,
  rawTotalEvents: raw, zoneTotalEvents: attention, blockedTotalEvents: blocked, countQuality: "estimated" as const, rawActions: [...(blocked > 0 ? [{ action: "block", count: blocked }] : []), ...(attention > 0 ? [{ action: "allow", count: attention }] : [])], topHosts: [] });
const dependencies = (discovery = discovered()) => ({
  cloudflare: { discoverZone: vi.fn().mockResolvedValue(discovery), collectHostSnapshot: vi.fn() },
  ai: { analyzeHosts: vi.fn() }, notification: { send: vi.fn().mockResolvedValue(undefined) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, rulesConfig,
  formatterOptions: { maxLength: 2000, topLimit: 3, timeZone: "Asia/Shanghai" },
});

describe("blocked event policy in Workers pipeline", () => {
  it("records controlled final decision diagnostics for a suppressed window", async () => {
    const deps = dependencies();
    await processHostAlert(queueMessage, deps);
    expect(deps.logger.info).toHaveBeenCalledWith("alert_decision", expect.objectContaining({
      final_decision: "suppressed", policy_id: "exclude-exact-block-v1", decision_version: "aggregate-quality-v2",
      raw_total_events: 100, attention_total_events: 0, raw_action_count_sum: 100,
      action_counts: [{ category: "block", count: 100 }], action_distribution_truncated: false,
      unknown_action_count: 0, filtered_top_host_count: 0, filtered_top_host_count_sum: 0,
      ai_called: false, wecom_called: false, invalid_ratios: expect.any(Array) as unknown, comparisons: expect.any(Array) as unknown,
    }));
  });
  it("does not log unknown raw Action text", async () => {
    const deps = dependencies({ ...discovered(100, 1, 99), rawActions: [{ action: "block", count: 99 }, { action: "private-path-/login?secret=fictional", count: 1 }] });
    await processHostAlert(queueMessage, deps);
    const log = JSON.stringify([...deps.logger.info.mock.calls, ...deps.logger.warn.mock.calls]);
    expect(log).toContain("other_non_block");
    expect(log).not.toContain("private-path");
    expect(log).toContain('"ai_called":false');
    expect(log).toContain('"wecom_called":true');
  });
  it("suppresses observed zero without LLM or notification", async () => {
    const deps = dependencies();
    expect(await processHostAlert(queueMessage, deps)).toMatchObject({ status: "suppressed", snapshotStatus: "suppressed", aiStatus: "not_requested" });
    expect(deps.cloudflare.collectHostSnapshot).not.toHaveBeenCalled();
    expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
    expect(deps.notification.send).not.toHaveBeenCalled();
    expect(deps.logger.info).toHaveBeenCalledWith("alert_suppressed", expect.objectContaining({
      reason: "no_attention_events_observed", policy_id: "exclude-exact-block-v1", event_scope: "attention",
      raw_total_events: 100, attention_total_events: 0, blocked_total_events: 100,
      incident_id: queueMessage.incidentId, correlation_id: queueMessage.correlationId,
      analysis_window: queueMessage.analysisWindow, wecom_status: "not_requested",
    }));
    expect(deps.logger.info.mock.calls.some(([event]) => event === "notification_sent")).toBe(false);
  });
  it("acks even if suppression logging throws", async () => {
    const deps = dependencies();
    deps.logger.info.mockImplementation(() => { throw new Error("log failure"); });
    const ack = vi.fn(); const retry = vi.fn();
    const message = { body: queueMessage, attempts: 1, ack, retry } as unknown as Message;
    const batch = { messages: [message] } as unknown as MessageBatch;
    await handleQueueBatch(batch, { processMessage: (message) => processHostAlert(message, deps),
      logger: deps.logger, clock: { now: () => new Date(queueMessage.queryStartedAt) } });
    expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(deps.notification.send).not.toHaveBeenCalled(); expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
  });
  it("sends a basic raw-empty notification", async () => {
    const deps = dependencies(discovered(0, 0, 0));
    expect(await processHostAlert(queueMessage, deps)).toMatchObject({ status: "sent", snapshotStatus: "empty" });
    expect(deps.notification.send).toHaveBeenCalledOnce(); expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
  });
  it("silences a block-only positive estimate difference", async () => {
    const deps = dependencies(discovered(100, 0, 99));
    expect(await processHostAlert(queueMessage, deps)).toMatchObject({ status: "suppressed", snapshotStatus: "suppressed" });
    expect(deps.notification.send).not.toHaveBeenCalled(); expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
  });
  it("sends a degraded notification if unfiltered actions contain an unknown category", async () => {
    const deps = dependencies(discovered(100, 0, 99));
    deps.cloudflare.discoverZone.mockResolvedValue({ ...discovered(100, 0, 99), rawActions: [{ action: "block", count: 99 }, { action: null, count: 1 }] });
    expect(await processHostAlert(queueMessage, deps)).toMatchObject({ status: "sent", snapshotStatus: "suppression_ineligible" });
    expect(deps.notification.send.mock.calls[0]?.[0]).toContain("处理动作未知");
    expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
  });
  it("does not treat a missing raw count as zero", async () => {
    const deps = dependencies();
    deps.cloudflare.discoverZone.mockResolvedValue({ ...discovered(), rawTotalEvents: undefined });
    expect(await processHostAlert(queueMessage, deps)).toMatchObject({ status: "sent", snapshotStatus: "collection_failed" });
    expect(deps.notification.send).toHaveBeenCalledOnce(); expect(deps.ai.analyzeHosts).not.toHaveBeenCalled();
  });
});

it("logs the discovery decision before external calls and actual terminal outcome afterward", async () => {
  const deps = dependencies(discovered(0, 0, 0));
  const order: string[] = [];
  deps.logger.info.mockImplementation((event: string) => { order.push(event); });
  deps.notification.send.mockImplementation(() => { order.push("notify"); return Promise.resolve(); });
  await processHostAlert(queueMessage, deps);
  const initial = deps.logger.info.mock.calls.find(([event]) => event === "analysis_decision");
  expect(initial?.[1]).toMatchObject({decision_phase: "before_external_calls", decision: "basic_exception", ai_called: false, wecom_called: false, llm_api_status: "not_requested", wecom_status: "not_requested"});
  expect(initial?.[1]).not.toHaveProperty("final_decision");
  expect(order.indexOf("analysis_decision")).toBeLessThan(order.indexOf("notify"));
  expect(order.indexOf("alert_decision")).toBeGreaterThan(order.indexOf("notify"));
  expect(deps.logger.info.mock.calls.find(([event]) => event === "alert_decision")?.[1]).toMatchObject({final_decision: "basic_exception", ai_called: false, wecom_called: true, wecom_status: "sent"});
});
