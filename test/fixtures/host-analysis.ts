import { ATTENTION_SCOPE } from "../../src/domain/event-scope";
import type { HostCollection } from "../../src/domain/host-analysis";
import type { CloudflareSnapshot } from "../../src/clients/cloudflare-graphql";

export const hostWindow = { start: "2026-09-24T00:00:00.000Z", end: "2026-09-24T00:31:00.000Z" };
export function hostFromSnapshot(snapshot: CloudflareSnapshot): HostCollection {
  return { ...ATTENTION_SCOPE, hostId: "h0", host: "example.test", discoveryCount: snapshot.totalEvents,
    hostTotalEvents: snapshot.totalEvents, collectionStatus: snapshot.totalEvents === 0 ? "empty" : "success",
    aggregates: { topIps: snapshot.topIps, topPaths: snapshot.topPaths, topCountries: snapshot.topCountries, topAsns: snapshot.topAsns, actions: snapshot.actions.map((item) => ({ ...item, value: item.value === "block" ? "log" : item.value })), sources: snapshot.sources },
    samples: snapshot.samples.map((sample) => ({ ...sample, action: sample.action === "block" ? "log" : sample.action })), samplesStatus: "success" };
}
export function makeHost(hostId = "h0", host = "example.test", total = 600): HostCollection {
  return { ...ATTENTION_SCOPE, hostId, host, discoveryCount: total, collectionStatus: "success", hostTotalEvents: total,
    aggregates: {
      topIps: [{ value: hostId === "h0" ? "192.0.2.10" : "198.51.100.20", count: total * 0.6 }],
      topPaths: [{ value: "/login", count: hostId === "h0" ? 300 : 30 }],
      topCountries: [{ value: "ZZ", count: total }], topAsns: [{ value: hostId === "h0" ? "AS64512" : "AS64513", count: total }],
      actions: [{ value: hostId === "h0" ? "log" : "allow", count: total }], sources: [{ value: "waf", count: total }],
    }, samplesStatus: "success", samples: Array.from({ length: 12 }, (_, index) => ({
      datetime: hostWindow.start, action: "log", clientIP: "192.0.2.10", clientCountryName: "ZZ",
      clientAsn: "64512", clientRequestHTTPHost: host, clientRequestPath: "/login", source: "waf",
      userAgent: index < 6 ? "Example/1" : index < 10 ? "Other/1" : index === 10 ? "" : null,
    })),
  };
}
