import {
  SamplesGraphQLResponseSchema,
  parseGraphQLData,
  DiscoveryGraphQLResponseSchema,
  HostGraphQLResponseSchema,
} from "./cloudflare-graphql-schema";
import { HostCollectionSchema, ZoneDiscoverySchema, type SelectedHost, type HostCollection, type ZoneDiscovery } from "../domain/host-analysis";
import { retryOperation, type RetryOptions } from "./retry";
import type { AnalysisWindow } from "../domain/queue-message";
import type { EvidenceItem, SecurityEventSample } from "../domain/incident";
import {
  AppError,
  classifyHttpError,
  classifyUnknownError,
  toExternalFailure,
} from "../observability/errors";
import { workerFetch } from "./fetch";

const CLOUDFLARE_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export interface SnapshotCollectionInput {
  readonly zoneTag: string;
  readonly analysisWindow: AnalysisWindow;
  readonly sampleLimit: number;
  readonly deadlineAt?: number;
  readonly metrics?: { requestCount: number; nodeSelectionCount: number };
}

export interface CloudflareSnapshot {
  readonly totalEvents: number;
  readonly topIps: EvidenceItem[];
  readonly topPaths: EvidenceItem[];
  readonly topHosts: EvidenceItem[];
  readonly topCountries: EvidenceItem[];
  readonly topAsns: EvidenceItem[];
  readonly actions: EvidenceItem[];
  readonly sources: EvidenceItem[];
  readonly samples: SecurityEventSample[];
}

export interface CloudflareGraphQLClientOptions {
  readonly token: string;
  readonly fetchFn?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly sleep?: RetryOptions["sleep"];
}

function toEvidence(
  groups: readonly { count: number; dimensions: Record<string, unknown> }[],
  key: string,
): EvidenceItem[] {
  return groups.map((entry) => ({ value: String(entry.dimensions[key]), count: entry.count }));
}

export class CloudflareGraphQLClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly retryOptions: RetryOptions;

  constructor(options: CloudflareGraphQLClientOptions) {
    this.token = options.token;
    this.fetchFn = options.fetchFn ?? workerFetch;
    this.endpoint = options.endpoint ?? CLOUDFLARE_GRAPHQL_ENDPOINT;
    this.timeoutMs = options.timeoutMs;
    this.retryOptions = {
      retries: options.retries,
      baseDelayMs: 100,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    };
  }

  async discoverZone(input: SnapshotCollectionInput): Promise<ZoneDiscovery> {
    const query = `query WafHostDiscovery($zoneTag: string!, $start: Time!, $end: Time!) {
      viewer { zones(filter: {zoneTag: $zoneTag}) {
        total: firewallEventsAdaptiveGroups(limit: 1, filter: {datetime_geq: $start, datetime_leq: $end}) { count }
        topHosts: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: {datetime_geq: $start, datetime_leq: $end}) { count dimensions { clientRequestHTTPHost } }
      } }
    }`;
    const data = parseGraphQLData(DiscoveryGraphQLResponseSchema, await this.request(query, {
      zoneTag: input.zoneTag, start: input.analysisWindow.start, end: input.analysisWindow.end,
    }, input.deadlineAt, input.metrics, 2));
    const zone = data.data.viewer.zones[0];
    if (zone === undefined) throw new AppError("cloudflare_response_invalid", "missing zone", false);
    return ZoneDiscoverySchema.parse({ zoneTotalEvents: zone.total[0]?.count ?? 0,
      topHosts: zone.topHosts.map((item) => ({ host: item.dimensions.clientRequestHTTPHost, count: item.count })),
    });
  }

  async collectHostSnapshot(input: SnapshotCollectionInput, selected: SelectedHost): Promise<HostCollection> {
    const variables = { zoneTag: input.zoneTag, start: input.analysisWindow.start, end: input.analysisWindow.end, host: selected.host };
    const filter = "{datetime_geq: $start, datetime_leq: $end, clientRequestHTTPHost: $host}";
    const dimensions = [ ["topIps", "clientIP", 10], ["topPaths", "clientRequestPath", 10],
      ["topCountries", "clientCountryName", 10], ["topAsns", "clientAsn", 10],
      ["actions", "action", 20], ["sources", "source", 20] ] as const;
    const query = `query WafHostSnapshot($zoneTag: string!, $start: Time!, $end: Time!, $host: string!) {
      viewer { zones(filter: {zoneTag: $zoneTag}) {
        total: firewallEventsAdaptiveGroups(limit: 1, filter: ${filter}) { count }
        ${dimensions.map(([alias, dimension, limit]) => `${alias}: firewallEventsAdaptiveGroups(limit: ${String(limit)}, orderBy: [count_DESC], filter: ${filter}) { count dimensions { ${dimension} } }`).join("\n")}
      } }
    }`;
    let base: HostCollection;
    try {
      const data = parseGraphQLData(HostGraphQLResponseSchema, await this.request(query, variables, input.deadlineAt, input.metrics, 7));
      const zone = data.data.viewer.zones[0];
      if (zone === undefined) throw new AppError("cloudflare_response_invalid", "missing zone", false);
      const total = zone.total[0]?.count ?? 0;
      base = HostCollectionSchema.parse({ ...selected, collectionStatus: total > 0 ? "success" : "empty",
        hostTotalEvents: total, aggregates: {
          topIps: toEvidence(zone.topIps, "clientIP"), topPaths: toEvidence(zone.topPaths, "clientRequestPath"),
          topCountries: toEvidence(zone.topCountries, "clientCountryName"),
          topAsns: toEvidence(zone.topAsns, "clientAsn").map((item) => ({ ...item, value: item.value.startsWith("AS") ? item.value : `AS${item.value}` })),
          actions: toEvidence(zone.actions, "action"), sources: toEvidence(zone.sources, "source"),
        }, samples: [], samplesStatus: "not_requested",
      });
    } catch (error) {
      return HostCollectionSchema.parse({ ...selected, collectionStatus: "failed", hostTotalEvents: null,
        aggregates: null, samples: [], samplesStatus: "not_requested", errorCode: classifyUnknownError(error, "cloudflare").code, failure: toExternalFailure(error, "cloudflare") });
    }
    try {
      const samplesQuery = `query WafHostSamples($zoneTag: string!, $start: Time!, $end: Time!, $host: string!, $sampleLimit: uint64!) {
        viewer { zones(filter: {zoneTag: $zoneTag}) {
          samples: firewallEventsAdaptive(limit: $sampleLimit, orderBy: [datetime_DESC], filter: ${filter}) {
            datetime action clientIP clientCountryName clientAsn clientRequestHTTPHost clientRequestPath source userAgent
          }
        } }
      }`;
      const data = parseGraphQLData(SamplesGraphQLResponseSchema, await this.request(samplesQuery, { ...variables, sampleLimit: input.sampleLimit }, input.deadlineAt, input.metrics, 1));
      const samples = data.data.viewer.zones[0]?.samples;
      if (samples === undefined || samples.some((sample) => sample.clientRequestHTTPHost !== selected.host)) throw new AppError("cloudflare_response_invalid", "invalid samples", false);
      return HostCollectionSchema.parse({ ...base, samplesStatus: "success", samples: samples.slice(0, input.sampleLimit).map((sample) => ({
        datetime: new Date(sample.datetime).toISOString(), action: sample.action, clientIP: sample.clientIP,
        clientCountryName: sample.clientCountryName ?? null, clientAsn: sample.clientAsn == null ? null : String(sample.clientAsn),
        clientRequestHTTPHost: sample.clientRequestHTTPHost, clientRequestPath: sample.clientRequestPath ?? null,
        source: sample.source ?? null, userAgent: sample.userAgent ?? null,
      })) });
    } catch (error) {
      return HostCollectionSchema.parse({ ...base, collectionStatus: "partial", samplesStatus: "failed", errorCode: classifyUnknownError(error, "cloudflare").code, failure: toExternalFailure(error, "cloudflare") });
    }
  }

  private async request(query: string, variables: Record<string, unknown>, deadlineAt?: number, metrics?: SnapshotCollectionInput["metrics"], nodes = 0): Promise<unknown> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    return retryOperation(async () => {
      const remaining = deadlineAt === undefined ? this.timeoutMs : deadlineAt - Date.now();
      if (remaining <= 0) throw new AppError("collection_budget_exhausted", "collection budget exhausted", false);
      if (metrics !== undefined) { metrics.requestCount++; metrics.nodeSelectionCount += nodes; }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const exhausted = deadlineAt !== undefined && Date.now() >= deadlineAt;
          const error = new AppError(exhausted ? "collection_budget_exhausted" : "cloudflare_timeout",
            "collection request timed out", !exhausted, undefined,
            { externalService: "cloudflare", failureKind: "timeout", durationMs: durationMs() });
          controller.abort(error);
          reject(error);
        }, Math.min(this.timeoutMs, remaining));
      });
      const attempt = async (): Promise<unknown> => {
        let response: Response;
        try {
          response = await this.fetchFn(this.endpoint, {
            method: "POST",
            headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal,
          });
        } catch (error) {
          throw classifyUnknownError(error, "cloudflare", durationMs());
        }
        if (!response.ok) throw classifyHttpError("cloudflare", response.status, durationMs());
        try {
          return await response.json();
        } catch {
          throw new AppError("cloudflare_response_invalid", "cloudflare_response_invalid", false, undefined, {
            externalService: "cloudflare", failureKind: "invalid_response", durationMs: durationMs(),
          });
        }
      };
      try {
        return await Promise.race([expired, attempt()]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }, {
      ...this.retryOptions,
      sleep: async (milliseconds) => {
        const remaining = deadlineAt === undefined ? milliseconds : deadlineAt - Date.now();
        if (remaining <= 0) throw new AppError("collection_budget_exhausted", "collection budget exhausted", false);
        const wait = this.retryOptions.sleep ?? ((delay: number) => new Promise<void>((resolve) => { setTimeout(resolve, delay); }));
        await wait(Math.min(milliseconds, remaining));
        if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new AppError("collection_budget_exhausted", "collection budget exhausted", false);
      },
    });
  }
}
