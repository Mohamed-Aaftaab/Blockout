import { sleep } from './sleep';

export interface RetryOptions {
  maxAttempts:  number;
  baseMs:       number;
  maxMs:        number;
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      if (attempt >= options.maxAttempts) throw e;
      if (options.shouldRetry !== undefined && !options.shouldRetry(e)) throw e;
      const base  = options.baseMs * Math.pow(2, attempt - 1);
      const delay = Math.min(base, options.maxMs) + Math.random() * 1000;
      await sleep(delay);
    }
  }
}
