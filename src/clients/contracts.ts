import type { AIAnalysisInput } from "../analysis/evidence";
import type { CloudflareSnapshot, SnapshotCollectionInput } from "./cloudflare-graphql";
import type { AIAnalysis } from "../domain/ai-analysis";

export interface CloudflareAnalyticsClient {
  collectSnapshot(input: SnapshotCollectionInput): Promise<CloudflareSnapshot>;
}

export interface AIAnalysisClient {
  analyze(input: AIAnalysisInput): Promise<AIAnalysis>;
}

export interface NotificationClient {
  send(message: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}
