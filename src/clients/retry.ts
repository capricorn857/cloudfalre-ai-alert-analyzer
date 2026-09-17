import { AppError } from "../observability/errors";

export interface RetryOptions {
  readonly retries: number;
  readonly baseDelayMs: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export async function retryOperation<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 2) {
    throw new Error("retries must be an integer between 0 and 2");
  }
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof AppError && error.retryable;
      if (!retryable || attempt >= options.retries) throw error;
      await sleep(options.baseDelayMs * 2 ** attempt);
    }
  }
}
