import type { Clock } from "../clients/contracts";
import { QueueMessageSchema, type QueueMessage } from "../domain/queue-message";
import type { Logger } from "../observability/logger";
import { validateFixedWindow } from "./window";

export interface QueueHandlerDependencies {
  readonly processMessage: (message: QueueMessage) => Promise<unknown>;
  readonly clock: Clock;
  readonly logger: Logger;
}

function safeLog(operation: () => void): void {
  try {
    operation();
  } catch {
    // Observability must not change queue acknowledgement semantics.
  }
}

export async function handleQueueBatch(
  batch: MessageBatch,
  dependencies: QueueHandlerDependencies,
): Promise<void> {
  for (const queueMessage of batch.messages) {
    const parsed = QueueMessageSchema.safeParse(queueMessage.body);
    if (!parsed.success) {
      safeLog(() => {
        dependencies.logger.warn("queue_message_invalid", {
          queue_attempt: queueMessage.attempts,
          error_code: "input_invalid",
        });
      });
      queueMessage.ack();
      continue;
    }

    try {
      validateFixedWindow(parsed.data);
    } catch {
      safeLog(() => {
        dependencies.logger.warn("queue_message_invalid", {
          incident_id: parsed.data.incidentId,
          correlation_id: parsed.data.correlationId,
          queue_attempt: queueMessage.attempts,
          error_code: "fixed_window_invalid",
        });
      });
      queueMessage.ack();
      continue;
    }

    safeLog(() => {
      dependencies.logger.info("queue_processing_started", {
        incident_id: parsed.data.incidentId,
        correlation_id: parsed.data.correlationId,
        analysis_window: parsed.data.analysisWindow,
        query_started_at: parsed.data.queryStartedAt,
        processing_started_at: dependencies.clock.now().toISOString(),
        queue_attempt: queueMessage.attempts,
      });
    });

    try {
      await dependencies.processMessage(parsed.data);
      queueMessage.ack();
    } catch (error) {
      safeLog(() => {
        dependencies.logger.error("queue_processing_failed", {
          incident_id: parsed.data.incidentId,
          correlation_id: parsed.data.correlationId,
          queue_attempt: queueMessage.attempts,
          error,
          error_code: "queue_processing_failed",
        });
      });
      queueMessage.retry();
    }
  }
}
