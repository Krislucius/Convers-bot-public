import { MODEL_UNAVAILABLE } from "./catalog.ts";
import { isVerifiedAvailable, type ModelAccess } from "./discover.ts";
import { MIN_COUNCIL_MEMBERS, type CouncilMember } from "./members.ts";
import type { NanoGptBillingMode } from "./nano-billing.ts";
import type { ProviderId } from "./types.ts";

export const MIN_CALLABLE_MODELS = MIN_COUNCIL_MEMBERS;

export type PreflightKind = "PROVIDER" | "SUBSCRIPTION" | "CATALOG" | "MODEL";
export type PreflightStepStatus = "WAITING" | "RUNNING" | "PASS" | "FAILED" | "SKIPPED";
export type PreflightStatus = "PENDING" | "RUNNING" | "PASS" | "FAILED";

export type PreflightStep = {
  id: string;
  kind: PreflightKind;
  memberId?: string;
  modelId?: string;
  label: string;
  status: PreflightStepStatus;
  latencyMs: number | null;
  error: string | null;
  httpStatus: number | null;
  requestId?: string | null;
  access?: ModelAccess | null;
};

export type PreflightReport = {
  status: PreflightStatus;
  steps: PreflightStep[];
  callableMemberIds: string[];
  blockedMemberIds: string[];
};

export type SubscriptionUsage = {
  active: boolean;
  exhausted: boolean;
  remaining: number | null;
  limit: number | null;
  status: string | null;
  rawKind: string;
};

export function seedPreflight(opts: {
  members: CouncilMember[];
  provider: ProviderId;
  nanogptBilling?: NanoGptBillingMode | null;
}): PreflightReport {
  const needsUsage = opts.provider === "nanogpt" && (opts.nanogptBilling ?? "subscription") !== "payg";
  const steps: PreflightStep[] = [
    {
      id: "PROVIDER",
      kind: "PROVIDER",
      label: "PROVIDER CHECK",
      status: "WAITING",
      latencyMs: null,
      error: null,
      httpStatus: null,
    },
    {
      id: "SUBSCRIPTION",
      kind: "SUBSCRIPTION",
      label: "SUBSCRIPTION",
      status: needsUsage ? "WAITING" : "SKIPPED",
      latencyMs: null,
      error: needsUsage ? null : "Not a NanoGPT subscription run.",
      httpStatus: null,
    },
    {
      id: "CATALOG",
      kind: "CATALOG",
      label: "CATALOG",
      status: "WAITING",
      latencyMs: null,
      error: null,
      httpStatus: null,
    },
    ...opts.members.map((member, index) => ({
      id: `MODEL:${member.memberId}`,
      kind: "MODEL" as const,
      memberId: member.memberId,
      modelId: member.modelId,
      label: `MODEL ${index + 1} · ${member.label}`,
      status: "WAITING" as const,
      latencyMs: null,
      error: null,
      httpStatus: null,
    })),
  ];
  return { status: "PENDING", steps, callableMemberIds: [], blockedMemberIds: [] };
}

export function nextPreflightStep(report: PreflightReport): PreflightStep | null {
  return report.steps.find((step) => step.status === "WAITING") ?? null;
}

export function patchPreflightStep(report: PreflightReport, next: PreflightStep): PreflightReport {
  const steps = report.steps.map((step) => (step.id === next.id ? next : step));
  const models = steps.filter((step) => step.kind === "MODEL");
  const callableMemberIds = models
    .filter((step) => step.status === "PASS" && isVerifiedAvailable(step.access))
    .map((step) => step.memberId)
    .filter((id): id is string => Boolean(id));
  const blockedMemberIds = models
    .filter((step) => step.status === "FAILED" || (step.status === "PASS" && !isVerifiedAvailable(step.access)))
    .map((step) => step.memberId)
    .filter((id): id is string => Boolean(id));
  const pending = steps.some((step) => step.status === "WAITING" || step.status === "RUNNING");
  const failedHard = steps.some(
    (step) =>
      (step.kind === "PROVIDER" || step.kind === "SUBSCRIPTION" || step.kind === "CATALOG") &&
      step.status === "FAILED",
  );
  let status: PreflightStatus = "RUNNING";
  if (failedHard) status = "FAILED";
  else if (!pending) status = "PASS";
  else if (steps.some((step) => step.status === "RUNNING" || step.status === "PASS" || step.status === "FAILED")) {
    status = "RUNNING";
  } else status = "PENDING";
  return { status, steps, callableMemberIds, blockedMemberIds };
}

export function evaluatePreflightGate(
  report: PreflightReport,
  minCallable = MIN_CALLABLE_MODELS,
): { ok: boolean; error?: string; callable: string[]; blocked: string[] } {
  const pending = nextPreflightStep(report);
  if (pending) {
    return {
      ok: false,
      error: `PREFLIGHT incomplete: ${pending.label} has not finished.`,
      callable: report.callableMemberIds,
      blocked: report.blockedMemberIds,
    };
  }
  const hard = report.steps.find(
    (step) =>
      (step.kind === "PROVIDER" || step.kind === "SUBSCRIPTION" || step.kind === "CATALOG") &&
      step.status === "FAILED",
  );
  if (hard) {
    return {
      ok: false,
      error: hard.error || `${hard.label} failed.`,
      callable: report.callableMemberIds,
      blocked: report.blockedMemberIds,
    };
  }
  if (report.callableMemberIds.length < minCallable) {
    const blocked = report.steps
      .filter((step) => step.kind === "MODEL" && step.status === "FAILED")
      .map((step) => `${step.modelId ?? step.label}${step.error ? ` (${step.error})` : ""}`)
      .join(", ");
    return {
      ok: false,
      error: `${MODEL_UNAVAILABLE}: only ${report.callableMemberIds.length} of ${minCallable} required selected models are currently callable.${blocked ? ` ${blocked}` : ""}`,
      callable: report.callableMemberIds,
      blocked: report.blockedMemberIds,
    };
  }
  return { ok: true, callable: report.callableMemberIds, blocked: report.blockedMemberIds };
}

export function parseSubscriptionUsage(payload: unknown, httpStatus: number): SubscriptionUsage {
  const empty: SubscriptionUsage = {
    active: httpStatus >= 200 && httpStatus < 300,
    exhausted: httpStatus === 402,
    remaining: null,
    limit: null,
    status: null,
    rawKind: payload == null ? "empty" : typeof payload,
  };
  if (httpStatus === 401 || httpStatus === 403) {
    return { ...empty, active: false, status: "unauthorized" };
  }
  if (httpStatus === 402) {
    return { ...empty, active: false, exhausted: true, status: "exhausted" };
  }
  if (payload == null || typeof payload !== "object") return empty;
  const row = payload as Record<string, unknown>;
  const nested =
    row.subscription && typeof row.subscription === "object"
      ? (row.subscription as Record<string, unknown>)
      : row.usage && typeof row.usage === "object"
        ? (row.usage as Record<string, unknown>)
        : row;
  const status = String(nested.status ?? row.status ?? "").trim().toLowerCase() || null;
  const remaining = num(nested.remaining ?? nested.remaining_credits ?? nested.credits_remaining ?? row.remaining);
  const limit = num(nested.limit ?? nested.quota ?? nested.credits_limit ?? row.limit);
  const activeFlag = bool(nested.active ?? nested.is_active ?? row.active);
  const exhaustedFlag =
    bool(nested.exhausted ?? row.exhausted) === true ||
    status === "exhausted" ||
    status === "inactive" ||
    status === "expired" ||
    status === "cancelled" ||
    (remaining === 0 && limit != null && limit > 0);
  const active =
    activeFlag === false || exhaustedFlag || status === "inactive" || status === "expired" || status === "cancelled"
      ? false
      : activeFlag === true || (httpStatus >= 200 && httpStatus < 300 && !exhaustedFlag);
  return {
    active,
    exhausted: exhaustedFlag,
    remaining,
    limit,
    status,
    rawKind: Array.isArray(payload) ? "array" : "object",
  };
}

export function subscriptionBlocksRun(usage: SubscriptionUsage, httpStatus: number): string | null {
  if (httpStatus === 401 || httpStatus === 403) {
    return "SUBSCRIPTION unauthorized. Check API Settings and save a valid NanoGPT key.";
  }
  if (httpStatus === 402 || usage.exhausted) {
    return "SUBSCRIPTION_LIMIT_REACHED HTTP 402. Subscription limit reached.";
  }
  if (httpStatus === 429) return "RATE_LIMITED HTTP 429. Rate limited.";
  if (httpStatus === 0) return "SUBSCRIPTION timeout or network error.";
  if (!usage.active) {
    return `SUBSCRIPTION inactive${usage.status ? ` (${usage.status})` : ""}.`;
  }
  return null;
}

export function accessFromProbe(opts: {
  status: number;
  error?: string | null;
  body?: string | null;
  inCatalog: boolean;
}): ModelAccess {
  const raw = `${opts.error ?? ""} ${opts.body ?? ""}`.toLowerCase();
  if (opts.status === 401) return "UNAVAILABLE";
  if (opts.status >= 200 && opts.status < 300) return "VERIFIED_AVAILABLE";
  if (
    opts.status === 403 ||
    /not included|not (?:in|on) (?:your )?subscription|no access to this model|model not (?:allowed|enabled)/.test(raw)
  ) {
    return "NOT_INCLUDED";
  }
  if (opts.status === 404 || /model[_ ]?not[_ ]?found|unknown model|invalid model/.test(raw)) {
    return "UNAVAILABLE";
  }
  if (!opts.inCatalog) return "UNAVAILABLE";
  if (opts.status === 429 || opts.status >= 500 || opts.status === 0) return "UNKNOWN";
  return "UNKNOWN";
}

export function modelProbeCallable(access: ModelAccess | null | undefined): boolean {
  return isVerifiedAvailable(access);
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return null;
}

export function interpretAccessForModel(
  modelId: string,
  result: { ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string },
): { access: ModelAccess; error: string | null } {
  const hit = result.blocked.find((row) => row.id === modelId);
  if (hit) {
    return { access: (hit.access as ModelAccess) || "UNAVAILABLE", error: result.error ?? null };
  }
  if (result.ok) return { access: "VERIFIED_AVAILABLE", error: null };
  if (/not connected|key rejected|unauthorized|401/i.test(result.error ?? "")) {
    return { access: "UNAVAILABLE", error: result.error ?? "KEY_REJECTED" };
  }
  return { access: "VERIFIED_AVAILABLE", error: null };
}
