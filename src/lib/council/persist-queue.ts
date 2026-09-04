/** Retry account writes so a late bearer / transient PGLite close does not drop keys or projects. */

export const PERSIST_ATTEMPTS = 3;
export const PERSIST_RETRY_MS = 250;

export function persistRetryDelay(attempt: number, base = PERSIST_RETRY_MS): number {
  return base * (attempt + 1);
}

export function isRetryablePersistError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unauthorized|pglite is closed|fetch|network|failed to fetch|timed out|timeout|502|503|504/i.test(
    message,
  );
}

export async function runWithPersistRetry<T>(
  op: () => Promise<T>,
  opts?: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
    retry?: (err: unknown) => boolean;
  },
): Promise<T> {
  const attempts = opts?.attempts ?? PERSIST_ATTEMPTS;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retry = opts?.retry ?? isRetryablePersistError;
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await op();
    } catch (err) {
      last = err;
      if (i === attempts - 1 || !retry(err)) break;
      await sleep(persistRetryDelay(i));
    }
  }
  throw last;
}
