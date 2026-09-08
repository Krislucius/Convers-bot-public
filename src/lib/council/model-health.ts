/** Observed provider reliability for later recommendations. One timeout is not a permanent ban. */

export type HealthOutcome = "success" | "failure" | "timeout" | "rate_limited" | "empty";

export type ModelHealthSample = {
  modelId: string;
  at: string;
  kind: "probe" | "runtime";
  outcome: HealthOutcome;
  latencyMs: number | null;
  httpStatus: number | null;
};

export type ModelHealth = {
  modelId: string;
  samples: number;
  successes: number;
  failures: number;
  timeouts: number;
  rateLimited: number;
  probeLatencyMs: number | null;
  runtimeLatencyMs: number | null;
  lastOutcome: HealthOutcome | null;
  lastAt: string | null;
  /** 0..1. Transient failures decay; a single timeout never zeros this. */
  reliability: number;
};

const EMPTY: Omit<ModelHealth, "modelId"> = {
  samples: 0,
  successes: 0,
  failures: 0,
  timeouts: 0,
  rateLimited: 0,
  probeLatencyMs: null,
  runtimeLatencyMs: null,
  lastOutcome: null,
  lastAt: null,
  reliability: 0.5,
};

export function emptyHealth(modelId: string): ModelHealth {
  return { modelId, ...EMPTY };
}

export function recordHealth(current: ModelHealth | null | undefined, sample: ModelHealthSample): ModelHealth {
  const prev = current ?? emptyHealth(sample.modelId);
  const successes = prev.successes + (sample.outcome === "success" ? 1 : 0);
  const timeouts = prev.timeouts + (sample.outcome === "timeout" ? 1 : 0);
  const rateLimited = prev.rateLimited + (sample.outcome === "rate_limited" ? 1 : 0);
  const failures =
    prev.failures +
    (sample.outcome === "failure" || sample.outcome === "empty" || sample.outcome === "timeout" ? 1 : 0);
  const samples = prev.samples + 1;
  const probeLatencyMs =
    sample.kind === "probe" && sample.latencyMs != null
      ? mix(prev.probeLatencyMs, sample.latencyMs)
      : prev.probeLatencyMs;
  const runtimeLatencyMs =
    sample.kind === "runtime" && sample.latencyMs != null
      ? mix(prev.runtimeLatencyMs, sample.latencyMs)
      : prev.runtimeLatencyMs;
  const successRate = samples ? successes / samples : 0.5;
  const timeoutPenalty = Math.min(0.25, timeouts * 0.08);
  const slow = Math.max(probeLatencyMs ?? 0, runtimeLatencyMs ?? 0);
  const slowPenalty = slow > 8_000 ? 0.12 : slow > 4_000 ? 0.06 : 0;
  const ratePenalty = Math.min(0.2, rateLimited * 0.05);
  let reliability = successRate - timeoutPenalty - slowPenalty - ratePenalty;
  if (sample.outcome === "timeout" && samples === 1) reliability = Math.max(reliability, 0.35);
  reliability = Math.min(1, Math.max(0.05, reliability));
  return {
    modelId: sample.modelId,
    samples,
    successes,
    failures,
    timeouts,
    rateLimited,
    probeLatencyMs,
    runtimeLatencyMs,
    lastOutcome: sample.outcome,
    lastAt: sample.at,
    reliability,
  };
}

export function healthScoreBoost(health: ModelHealth | null | undefined): number {
  if (!health || health.samples === 0) return 0;
  const rel = health.reliability;
  if (rel >= 0.8) return 6;
  if (rel >= 0.6) return 2;
  if (rel >= 0.4) return -4;
  return -10;
}

export function outcomeFromFailure(errorClass?: string | null, httpClass?: string | null): HealthOutcome {
  if (errorClass === "TIMEOUT" || httpClass === "timeout") return "timeout";
  if (errorClass === "RATE_LIMITED" || httpClass === "429") return "rate_limited";
  if (errorClass === "EMPTY_RESPONSE" || httpClass === "empty") return "empty";
  return "failure";
}

function mix(prev: number | null, next: number): number {
  if (prev == null) return next;
  return Math.round(prev * 0.6 + next * 0.4);
}
