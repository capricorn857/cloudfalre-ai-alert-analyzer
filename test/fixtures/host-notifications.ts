import { ATTENTION_SCOPE } from "../../src/domain/event-scope";
import { attentionCounts } from "./blocked-events";
import type { MultiHostAIResponse } from "../../src/domain/ai-analysis";
import type { HostCollection, ZoneDiscovery } from "../../src/domain/host-analysis";
import type { QueueMessage } from "../../src/domain/queue-message";
import { queueMessage } from "./domain";
import { hostWindow, makeHost } from "./host-analysis";

export type NotificationScenario = "normal" | "partial" | "ai_fallback" | "long";

export function makeNotificationFixture(scenario: NotificationScenario): {
  message: QueueMessage; discovery: ZoneDiscovery; collections: HostCollection[]; ai: MultiHostAIResponse; aiFailure: boolean;
} {
  const totals = scenario === "long" ? [400, 350, 300, 250, 100] : [600, 300];
  const collections = totals.map((total, index) => makeHost("h" + String(index), index === 0 ? "example.test" : index === 1 ? "www.example.test" : "host" + String(index) + ".example.test", total));
  const second = collections[1];
  if (second !== undefined && second.aggregates !== null) second.aggregates.actions = [{ value: "log", count: 60 }, { value: "allow", count: second.discoveryCount - 60 }];
  if (scenario === "partial" && second !== undefined) collections[1] = { ...ATTENTION_SCOPE, hostId: second.hostId, host: second.host, discoveryCount: second.discoveryCount,
    collectionStatus: "failed", hostTotalEvents: null, aggregates: null, samples: [], samplesStatus: "not_requested", errorCode: "cloudflare_timeout" };
  if (scenario === "long") for (const collection of collections) if (collection.aggregates !== null) collection.aggregates.topPaths = [{ value: "/" + "界".repeat(1000), count: collection.discoveryCount }];
  const id = "demo-" + scenario;
  const message: QueueMessage = { ...structuredClone(queueMessage), incidentId: id, correlationId: id,
    webhookReceivedAt: "2026-09-24T00:30:00.000Z", queryStartedAt: hostWindow.end, analysisWindow: hostWindow,
    configSnapshot: { ...queueMessage.configSnapshot, hostLimit: scenario === "long" ? 5 : 3 },
    alert: { ...queueMessage.alert, correlationId: id, alertTime: "2026-09-24T00:30:00.000Z" },
  };
  return {
    message, collections, aiFailure: scenario === "ai_fallback" || scenario === "long",
    discovery: { ...attentionCounts(scenario === "long" ? 1500 : 1000), topHosts: collections.map((host) => ({ host: host.host, count: host.discoveryCount })) },
    ai: { hosts: collections.filter((host) => host.collectionStatus !== "failed").map((host) => ({ hostId: host.hostId, status: "valid", analysis: {
      host_id: host.hostId, risk: { level: "Unknown", evidence_ids: [] }, attack: { type: "Unknown", confidence: 0, evidence_ids: [] },
      observations: [], recommendations: [{ kind: "manual_dashboard", evidence_ids: [host.hostId + ":ctx:0"] }],
    } })) },
  };
}
