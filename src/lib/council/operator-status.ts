import type { AgentProgress } from "./types.ts";

export const OPERATOR_KINDS = ["WORKING", "COMPLETE", "STOPPED", "ERROR"] as const;
export type OperatorKind = (typeof OPERATOR_KINDS)[number];

export const OPERATOR_STAGES = ["PREPARE", "PROBE", "ROUND_1", "ROUND_2", "SYNTHESIS", "FINALIZE"] as const;
export type OperatorStage = (typeof OPERATOR_STAGES)[number];

export type MemberOpState = "WAITING" | "WORKING" | "READY" | "FAILED";

export function hasTaskVerdict(result: { status?: string | null; reconciledStatus?: string | null } | null | undefined): boolean {
  const verdict = result?.reconciledStatus ?? result?.status ?? null;
  return Boolean(verdict);
}

export function operatorKind(input: {
  terminal: "COMPLETE" | "FAILED" | "CANCELLED" | null;
  hasVerdict: boolean;
}): OperatorKind {
  if (input.terminal === "CANCELLED") return "STOPPED";
  if (input.terminal === "FAILED") return "ERROR";
  if (input.terminal === "COMPLETE" && input.hasVerdict) return "COMPLETE";
  if (input.terminal === "COMPLETE" && !input.hasVerdict) return "ERROR";
  return "WORKING";
}

export function operatorStage(input: {
  stage?: string | null;
  status?: string | null;
  internalStage?: string | null;
  preflightPending?: boolean;
}): OperatorStage | null {
  const stage = String(input.stage ?? "");
  const status = String(input.status ?? "");
  const internal = String(input.internalStage ?? "");
  if (stage === "FINALIZING" || status === "FINALIZING") return "FINALIZE";
  if (stage === "SYNTHESIS" || status === "SYNTHESIS") return "SYNTHESIS";
  if (stage === "ROUND_2" || status === "ROUND_2" || status === "COUNCIL_ROUND_2") return "ROUND_2";
  if (stage === "ROUND_1" || status === "ROUND_1" || status === "COUNCIL_ROUND_1") return "ROUND_1";
  if (
    input.preflightPending ||
    internal.startsWith("PREFLIGHT") ||
    internal === "PREFLIGHT" ||
    /PREFLIGHT|MODEL_PROBE|CATALOG|SUBSCRIPTION/.test(internal)
  ) {
    return "PROBE";
  }
  if (stage === "PREPARING" || status === "PREPARING" || stage === "QUEUED" || status === "QUEUED") return "PREPARE";
  return "PREPARE";
}

export function memberOpState(progress?: Pick<AgentProgress, "state" | "detail"> | null): MemberOpState {
  const state = progress?.state ?? "WAITING";
  if (state === "FAILED") return "FAILED";
  if (state === "DONE") return "READY";
  if (state === "RUNNING" || progress?.detail === "PROBING" || progress?.detail === "RUNNING") return "WORKING";
  return "WAITING";
}

export function memberOpKey(state: MemberOpState): string {
  if (state === "READY") return "operator.memberReady";
  if (state === "WORKING") return "operator.memberWorking";
  if (state === "FAILED") return "operator.memberFailed";
  return "operator.memberWaiting";
}

export function stageKey(stage: OperatorStage | null): string {
  if (stage === "PROBE") return "operator.probe";
  if (stage === "ROUND_1") return "operator.round1";
  if (stage === "ROUND_2") return "operator.round2";
  if (stage === "SYNTHESIS") return "operator.synthesis";
  if (stage === "FINALIZE") return "operator.finalize";
  return "operator.prepare";
}

export function kindKey(kind: OperatorKind): string {
  if (kind === "COMPLETE") return "operator.complete";
  if (kind === "STOPPED") return "operator.stopped";
  if (kind === "ERROR") return "operator.error";
  return "operator.working";
}

export function formatActivityAge(iso: string | null | undefined, nowMs: number, locale: "en" | "ru"): string {
  if (!iso) return locale === "ru" ? "нет данных" : "pending";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return locale === "ru" ? "нет данных" : "pending";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 5) return locale === "ru" ? "только что" : "just now";
  if (sec < 60) return locale === "ru" ? `${sec} сек назад` : `${sec}s ago`;
  const min = Math.max(1, Math.round(sec / 60));
  return locale === "ru" ? `${min} мин назад` : `${min}m ago`;
}

export const TECHNICAL_STAGE_RE = /LEASE_WAIT|DISPATCH_PENDING|SCHEDULER_WAIT|PREFLIGHT_/;

export function isTechnicalStage(value: string | null | undefined): boolean {
  return Boolean(value && TECHNICAL_STAGE_RE.test(value));
}
