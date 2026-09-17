import { CloudflareAlertPayloadSchema } from "../domain/alert";
import { QueueMessageSchema, type QueueMessage } from "../domain/queue-message";
import { mapCloudflareAlert } from "./dispatcher";

export interface WindowConfig {
  readonly beforeMinutes: number;
  readonly settleSeconds: number;
  readonly sampleLimit: number;
}

export function buildQueueMessage(
  input: unknown,
  config: WindowConfig,
  now: Date,
): QueueMessage {
  const payload = CloudflareAlertPayloadSchema.parse(input);
  const alert = mapCloudflareAlert(payload);
  if (alert === null) throw new Error("Unsupported alert type");

  const webhookReceivedAt = new Date(now);
  const queryStartedAt = new Date(webhookReceivedAt.getTime() + config.settleSeconds * 1000);
  const windowStart = new Date(
    new Date(alert.alertTime).getTime() - config.beforeMinutes * 60 * 1000,
  );

  return QueueMessageSchema.parse({
    schemaVersion: 1,
    incidentId: alert.correlationId,
    correlationId: alert.correlationId,
    webhookReceivedAt: webhookReceivedAt.toISOString(),
    queryStartedAt: queryStartedAt.toISOString(),
    analysisWindow: {
      start: windowStart.toISOString(),
      end: queryStartedAt.toISOString(),
    },
    configSnapshot: config,
    alert,
  });
}

export function validateFixedWindow(input: unknown): asserts input is QueueMessage {
  const message = QueueMessageSchema.parse(input);
  const expectedQueryStart = new Date(
    Date.parse(message.webhookReceivedAt) + message.configSnapshot.settleSeconds * 1000,
  ).toISOString();
  const expectedWindowStart = new Date(
    Date.parse(message.alert.alertTime) - message.configSnapshot.beforeMinutes * 60 * 1000,
  ).toISOString();

  if (
    message.queryStartedAt !== expectedQueryStart ||
    message.analysisWindow.start !== expectedWindowStart ||
    message.analysisWindow.end !== message.queryStartedAt
  ) {
    throw new Error("Queue message fixed window is inconsistent");
  }
}
