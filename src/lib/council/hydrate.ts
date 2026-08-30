import type { AccountSettingsPublic, StoreShape } from "./types";

export const HYDRATE_TIMEOUT_MS = 8_000;
export const UNAUTHORIZED_ATTEMPTS = 3;

export class HydrateTimeoutError extends Error {
  readonly status = 504;
  constructor(ms = HYDRATE_TIMEOUT_MS) {
    super(`Timed out after ${Math.round(ms / 1000)}s while loading this account.`);
    this.name = "HydrateTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new HydrateTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Run snapshot queries one-by-one so a Neon pooler is not saturated. */
export async function runSerialQueries<T>(queries: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = [];
  for (const query of queries) out.push(await query());
  return out;
}

export async function loadHydratePayload(input: {
  load?: () => Promise<{ snapshot: StoreShape; settings: AccountSettingsPublic }>;
  loadSnapshot?: () => Promise<StoreShape>;
  loadSettings?: () => Promise<AccountSettingsPublic>;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ snapshot: StoreShape; settings: AccountSettingsPublic }> {
  const timeoutMs = input.timeoutMs ?? HYDRATE_TIMEOUT_MS;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const load =
    input.load ??
    (async () => {
      if (!input.loadSnapshot || !input.loadSettings) {
        throw new Error("Could not load this account.");
      }
      const [snapshot, settings] = await Promise.all([input.loadSnapshot(), input.loadSettings()]);
      return { snapshot, settings };
    });

  const run = async () => {
    let lastErr: unknown;
    for (let i = 0; i < UNAUTHORIZED_ATTEMPTS; i += 1) {
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) throw new HydrateTimeoutError(timeoutMs);
      try {
        const payload = await load();
        if (!payload?.snapshot || !payload.settings) throw new Error("Could not load this account.");
        return payload;
      } catch (err) {
        lastErr = err;
        if (err instanceof HydrateTimeoutError) throw err;
        const message = err instanceof Error ? err.message : "";
        if (message !== "Unauthorized") throw err;
        await sleep(Math.min(400 * (i + 1), Math.max(0, remaining)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Could not load this account.");
  };

  return withTimeout(run(), timeoutMs);
}
