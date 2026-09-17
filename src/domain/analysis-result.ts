import type { Finding } from "./finding";
import type { Incident } from "./incident";
import type { QueueMessage } from "./queue-message";
import type { Statistics } from "./statistics";

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
}

export type SnapshotAnalysisResult = SnapshotAnalysisSuccess | SnapshotCollectionFailed;
