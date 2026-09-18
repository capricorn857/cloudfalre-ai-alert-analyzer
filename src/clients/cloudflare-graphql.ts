import {
  AggregateGraphQLResponseSchema,
  SamplesGraphQLResponseSchema,
  parseGraphQLData,
} from "./cloudflare-graphql-schema";
import { retryOperation, type RetryOptions } from "./retry";
import type { AnalysisWindow } from "../domain/queue-message";
import type { EvidenceItem, SecurityEventSample } from "../domain/incident";
import {
  AppError,
  classifyHttpError,
  classifyUnknownError,
} from "../observability/errors";
import { workerFetch } from "./fetch";

const CLOUDFLARE_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const AGGREGATE_QUERY = `query WafSnapshot($zoneTag: String!, $start: Time!, $end: Time!) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    total: firewallEventsAdaptiveGroups(limit: 1, filter: { datetime_geq: $start, datetime_leq: $end }) { count }
    topIps: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { clientIP } }
    topPaths: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { clientRequestPath } }
    topHosts: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { clientRequestHTTPHost } }
    topCountries: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { clientCountryName } }
    topAsns: firewallEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { clientAsn } }
    actions: firewallEventsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { action } }
    sources: firewallEventsAdaptiveGroups(limit: 20, orderBy: [count_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) { count dimensions { source } }
  } }
}`;

const SAMPLES_QUERY = `query WafSamples($zoneTag: String!, $start: Time!, $end: Time!, $sampleLimit: Int!) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    samples: firewallEventsAdaptive(limit: $sampleLimit, orderBy: [datetime_DESC], filter: { datetime_geq: $start, datetime_leq: $end }) {
      datetime action clientIP clientCountryName clientAsn clientRequestHTTPHost clientRequestPath source userAgent
    }
  } }
}`;

export interface SnapshotCollectionInput {
  readonly zoneTag: string;
  readonly analysisWindow: AnalysisWindow;
  readonly sampleLimit: number;
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

  async collectSnapshot(input: SnapshotCollectionInput): Promise<CloudflareSnapshot> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    const variables = {
      zoneTag: input.zoneTag,
      start: input.analysisWindow.start,
      end: input.analysisWindow.end,
    };
    const aggregates = parseGraphQLData(
      AggregateGraphQLResponseSchema,
      await this.request(AGGREGATE_QUERY, variables),
      durationMs(),
    );
    const samples = parseGraphQLData(
      SamplesGraphQLResponseSchema,
      await this.request(SAMPLES_QUERY, { ...variables, sampleLimit: input.sampleLimit }),
      durationMs(),
    );
    const zone = aggregates.data.viewer.zones[0];
    const sampleZone = samples.data.viewer.zones[0];
    if (zone === undefined || sampleZone === undefined) {
      throw new AppError(
        "cloudflare_response_invalid",
        "cloudflare_response_invalid",
        false,
        undefined,
        {
          externalService: "cloudflare",
          failureKind: "invalid_response",
          durationMs: durationMs(),
        },
      );
    }

    return {
      totalEvents: zone.total[0]?.count ?? 0,
      topIps: toEvidence(zone.topIps, "clientIP"),
      topPaths: toEvidence(zone.topPaths, "clientRequestPath"),
      topHosts: toEvidence(zone.topHosts, "clientRequestHTTPHost"),
      topCountries: toEvidence(zone.topCountries, "clientCountryName"),
      topAsns: toEvidence(zone.topAsns, "clientAsn").map((item) => ({
        ...item,
        value: item.value.startsWith("AS") ? item.value : `AS${item.value}`,
      })),
      actions: toEvidence(zone.actions, "action"),
      sources: toEvidence(zone.sources, "source"),
      samples: sampleZone.samples.slice(0, input.sampleLimit).map((sample) => ({
        datetime: new Date(sample.datetime).toISOString(),
        action: sample.action,
        clientIP: sample.clientIP,
        clientCountryName: sample.clientCountryName ?? null,
        clientAsn: sample.clientAsn == null ? null : String(sample.clientAsn),
        clientRequestHTTPHost: sample.clientRequestHTTPHost ?? null,
        clientRequestPath: sample.clientRequestPath ?? null,
        source: sample.source ?? null,
        userAgent: sample.userAgent ?? null,
      })),
    };
  }

  private async request(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const durationMs = () => Date.now() - startedAt;
    return retryOperation(async () => {
      let response: Response;
      try {
        response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw classifyUnknownError(error, "cloudflare", durationMs());
      }
      if (!response.ok) throw classifyHttpError("cloudflare", response.status, durationMs());
      try {
        return await response.json();
      } catch {
        throw new AppError(
          "cloudflare_response_invalid",
          "cloudflare_response_invalid",
          false,
          undefined,
          {
            externalService: "cloudflare",
            failureKind: "invalid_response",
            durationMs: durationMs(),
          },
        );
      }
    }, this.retryOptions);
  }
}
