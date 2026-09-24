import type { EvidenceCatalog } from "../domain/evidence-catalog";
import type { CloudflareSnapshot, SnapshotCollectionInput } from "./cloudflare-graphql";
import type { AIAnalysis } from "../domain/ai-analysis";

export interface CloudflareAnalyticsClient {
  collectSnapshot(input: SnapshotCollectionInput): Promise<CloudflareSnapshot>;
}

export interface AIAnalysisClient {
  analyze(input: EvidenceCatalog): Promise<AIAnalysis>;
}

export interface NotificationClient {
  send(message: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}
