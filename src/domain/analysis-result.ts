import type { Finding } from "./finding";
import type { Incident } from "./incident";
import type { QueueMessage } from "./queue-message";
import type { Statistics } from "./statistics";
import type { ExternalFailure } from "../observability/errors";
import type { ScopedDiscovery } from "./event-scope";
import type { HostIncident } from "./host-analysis";

export interface SnapshotAnalysisSuccess {
  readonly status: "success" | "empty";
  readonly message: QueueMessage;
  readonly incident: Incident;
  readonly statistics: Statistics;
  readonly findings: Finding[];
}

export interface SnapshotCollectionFailed {
  readonly status: "collection_failed";
  readonly message: QueueMessage;
  readonly errorCode: string;
  readonly failure: ExternalFailure;
}

export type SnapshotAnalysisResult = SnapshotAnalysisSuccess | SnapshotCollectionFailed;

export type HostSnapshotAnalysisResult = ({
  readonly status: "success" | "partial" | "empty";
  readonly message: QueueMessage;
  readonly incident: HostIncident;
} | SnapshotCollectionFailed | {
  readonly status: "suppressed";
  readonly message: QueueMessage;
  readonly discovery: ScopedDiscovery;
  readonly reason: "no_attention_events_observed";
} | {
  readonly status: "suppression_ineligible";
  readonly message: QueueMessage;
  readonly discovery: ScopedDiscovery;
  readonly reason: "aggregate_inconsistent" | "action_unknown" | "action_distribution_incomplete";
}) & { collectionMetrics?: { requestCount: number; nodeSelectionCount: number } };
