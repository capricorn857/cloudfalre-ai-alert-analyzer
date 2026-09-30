import type { SnapshotCollectionInput } from "./cloudflare-graphql";
import type { MultiHostAIResponse } from "../domain/ai-analysis";
import type { HostEvidenceCatalog } from "../domain/host-evidence";
import type { SelectedHost, HostCollection, ZoneDiscovery } from "../domain/host-analysis";

export interface HostAnalyticsClient {
  discoverZone(input: SnapshotCollectionInput): Promise<ZoneDiscovery>;
  collectHostSnapshot(input: SnapshotCollectionInput, host: SelectedHost): Promise<HostCollection>;
}

export interface HostAIAnalysisClient {
  analyzeHosts(input: HostEvidenceCatalog): Promise<MultiHostAIResponse>;
}

export interface NotificationClient {
  send(message: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}
