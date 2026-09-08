/** Sequential Council pacing. Concurrency is always 1. */

export const INTER_REQUEST_MS = 1_500;
export const INTER_REQUEST_JITTER_MS = 1_000;
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 12_000;
export const RETRY_AFTER_CAP_MS = 20_000;
export const STALL_IDLE_MS = 8_000;

export type PacingConfig = {
  interRequestMs: number;
  jitterMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
  retryAfterCapMs: number;
};

export const DEFAULT_PACING: PacingConfig = {
  interRequestMs: INTER_REQUEST_MS,
  jitterMs: INTER_REQUEST_JITTER_MS,
  backoffBaseMs: BACKOFF_BASE_MS,
  backoffCapMs: BACKOFF_CAP_MS,
  retryAfterCapMs: RETRY_AFTER_CAP_MS,
};

export const TEST_PACING: PacingConfig = {
  interRequestMs: 0,
  jitterMs: 0,
  backoffBaseMs: 0,
  backoffCapMs: 0,
  retryAfterCapMs: 20_000,
};

export function resolvePacing(input?: Partial<PacingConfig> | null): PacingConfig {
  return {
    interRequestMs: Math.max(0, input?.interRequestMs ?? DEFAULT_PACING.interRequestMs),
    jitterMs: Math.max(0, input?.jitterMs ?? DEFAULT_PACING.jitterMs),
    backoffBaseMs: Math.max(0, input?.backoffBaseMs ?? DEFAULT_PACING.backoffBaseMs),
    backoffCapMs: Math.max(0, input?.backoffCapMs ?? DEFAULT_PACING.backoffCapMs),
    retryAfterCapMs: Math.max(0, input?.retryAfterCapMs ?? DEFAULT_PACING.retryAfterCapMs),
  };
}

/** Parse Retry-After as delta-seconds or HTTP-date. Returns milliseconds, or null. */
export function parseRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | null {
  const raw = String(header ?? "").trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - nowMs);
}

export function boundedBackoffMs(attempt: number, pacing: PacingConfig = DEFAULT_PACING): number {
  const base = Math.max(0, pacing.backoffBaseMs);
  if (base === 0) return 0;
  const exp = 2 ** Math.max(0, attempt - 1);
  return Math.min(pacing.backoffCapMs || BACKOFF_CAP_MS, base * exp);
}

/**
 * 429 with Retry-After: honor the header (capped so one tick cannot outlive the lease).
 * Retryable 5xx/network/timeout: 2s / 4s / 8s capped at 12s.
 */
export function retryWaitMs(opts: {
  attempt: number;
  errorClass?: string | null;
  httpClass?: string | null;
  retryAfterHeader?: string | null;
  retryAfterMs?: number | null;
  nowMs?: number;
  pacing?: Partial<PacingConfig> | null;
}): number {
  const pacing = resolvePacing(opts.pacing);
  const rateLimited = opts.errorClass === "RATE_LIMITED" || opts.httpClass === "429";
  const headerMs =
    opts.retryAfterMs != null && Number.isFinite(opts.retryAfterMs)
      ? Math.max(0, opts.retryAfterMs)
      : parseRetryAfter(opts.retryAfterHeader, opts.nowMs ?? Date.now());
  if (rateLimited && headerMs != null) {
    const cap = pacing.retryAfterCapMs || RETRY_AFTER_CAP_MS;
    return Math.min(headerMs, cap);
  }
  return boundedBackoffMs(opts.attempt, pacing);
}

export function interRequestDelayMs(
  pacing: Partial<PacingConfig> | null | undefined,
  random: () => number = Math.random,
): number {
  const resolved = resolvePacing(pacing);
  const jitter = resolved.jitterMs > 0 ? Math.floor(random() * (resolved.jitterMs + 1)) : 0;
  return resolved.interRequestMs + jitter;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type SerialGate = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  inFlight(): boolean;
};

export function createSerialGate(label = "provider"): SerialGate {
  let busy = false;
  return {
    inFlight: () => busy,
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (busy) throw new Error(`CONCURRENT_${label.toUpperCase()}_CALL`);
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
      }
    },
  };
}

export type StallStage = "LEASE_WAIT" | "PREFLIGHT" | "DISPATCH_PENDING" | "SCHEDULER_WAIT" | "FAILED";

export function stallAfterIdle(opts: {
  lastActivityAt: string | number | null | undefined;
  nowMs: number;
  idleMs?: number;
}): boolean {
  if (opts.lastActivityAt == null || opts.lastActivityAt === "") return false;
  const then =
    typeof opts.lastActivityAt === "number" ? opts.lastActivityAt : Date.parse(String(opts.lastActivityAt));
  if (!Number.isFinite(then)) return false;
  return opts.nowMs - then > (opts.idleMs ?? STALL_IDLE_MS);
}

export function diagnoseInternalStage(opts: {
  terminal?: boolean;
  failed?: boolean;
  leaseHeld?: boolean;
  preflightDone?: boolean;
  providerCallsStarted?: boolean;
  queued?: boolean;
}): StallStage {
  if (opts.failed || opts.terminal) return "FAILED";
  if (opts.leaseHeld) return "LEASE_WAIT";
  if (!opts.preflightDone) return "PREFLIGHT";
  if (!opts.providerCallsStarted) return "DISPATCH_PENDING";
  if (opts.queued) return "SCHEDULER_WAIT";
  return "DISPATCH_PENDING";
}
