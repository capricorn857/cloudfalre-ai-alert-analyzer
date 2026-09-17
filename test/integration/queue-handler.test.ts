import { describe, expect, it, vi } from "vitest";

import { handleQueueBatch } from "../../src/pipeline/queue-handler";
import { queueMessage } from "../fixtures/domain";

function fakeMessage(body: unknown, attempts = 1) {
  return {
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function fakeBatch(message: ReturnType<typeof fakeMessage>): MessageBatch {
  return { queue: "test-queue", messages: [message] } as unknown as MessageBatch;
}

describe("handleQueueBatch", () => {
  it("acks invalid poison messages without calling the pipeline", async () => {
    const message = fakeMessage({ invalid: true });
    const processMessage = vi.fn();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleQueueBatch(fakeBatch(message), {
      processMessage,
      clock: { now: () => new Date("2026-09-14T09:21:00Z") },
      logger,
    });

    expect(processMessage).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("queue_message_invalid", expect.any(Object));
  });

  it("uses the original fixed window, logs processing time, and acks success", async () => {
    const message = fakeMessage(structuredClone(queueMessage), 2);
    const processMessage = vi.fn().mockResolvedValue({ status: "sent" });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleQueueBatch(fakeBatch(message), {
      processMessage,
      clock: { now: () => new Date("2026-09-14T10:00:00Z") },
      logger,
    });

    expect(processMessage).toHaveBeenCalledWith(queueMessage);
    expect(message.body).toEqual(queueMessage);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "queue_processing_started",
      expect.objectContaining({
        processing_started_at: "2026-09-14T10:00:00.000Z",
        query_started_at: queueMessage.queryStartedAt,
        queue_attempt: 2,
      }),
    );
  });

  it("acks a handled notification failure without Queue retry", async () => {
    const message = fakeMessage(queueMessage);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processMessage = vi.fn().mockResolvedValue({ status: "notification_failed" });

    await handleQueueBatch(fakeBatch(message), {
      processMessage,
      clock: { now: () => new Date("2026-09-14T10:00:00Z") },
      logger,
    });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledOnce();
  });

  it("requests Queue retry for an unexpected pipeline crash", async () => {
    const message = fakeMessage(queueMessage);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await handleQueueBatch(fakeBatch(message), {
      processMessage: () => Promise.reject(new Error("unexpected crash")),
      clock: { now: () => new Date("2026-09-14T10:00:00Z") },
      logger,
    });

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "queue_processing_failed",
      expect.objectContaining({ error_code: "queue_processing_failed" }),
    );
  });
});
