import { describe, expect, it, vi } from "vitest";

import { retryOperation } from "../../../src/clients/retry";
import { AppError } from "../../../src/observability/errors";

describe("retryOperation", () => {
  it("returns immediately on success", async () => {
    const operation = vi.fn<() => Promise<string>>().mockResolvedValue("ok");

    await expect(retryOperation(operation, { retries: 2, baseDelayMs: 10 })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("retries transient errors up to the configured limit", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new AppError("temporary", "temporary", true))
      .mockResolvedValue("ok");

    await expect(
      retryOperation(operation, { retries: 2, baseDelayMs: 10, sleep }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it("does not retry permanent errors", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new AppError("permanent", "permanent", false));

    await expect(retryOperation(operation, { retries: 2, baseDelayMs: 10 })).rejects.toMatchObject({
      code: "permanent",
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("throws the final transient error after retry exhaustion", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new AppError("temporary", "temporary", true));

    await expect(
      retryOperation(operation, { retries: 2, baseDelayMs: 10, sleep }),
    ).rejects.toMatchObject({ code: "temporary" });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });
});
