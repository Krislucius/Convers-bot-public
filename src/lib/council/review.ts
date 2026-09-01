import type { CouncilResult, CouncilStatus, ReviewVerdict, TaskMode } from "./types.ts";

export const REVIEW_VERDICTS: ReviewVerdict[] = ["PASS", "PATCH", "BLOCKED"];

export function asReviewVerdict(value: unknown): ReviewVerdict | null {
  const text = String(value ?? "").toUpperCase();
  if (text === "PASS" || text === "APPROVED") return "PASS";
  if (text === "PATCH") return "PATCH";
  if (text === "BLOCKED") return "BLOCKED";
  return null;
}

export function councilStatusFromReview(verdict: ReviewVerdict | null, fallback: CouncilStatus): CouncilStatus {
  if (verdict === "PASS") return "APPROVED";
  if (verdict === "PATCH") return "PATCH";
  if (verdict === "BLOCKED") return "BLOCKED";
  return fallback;
}

export function reviewVerdictFromStatus(status: CouncilStatus | string | null | undefined): ReviewVerdict | null {
  if (status === "APPROVED") return "PASS";
  if (status === "PATCH") return "PATCH";
  if (status === "BLOCKED") return "BLOCKED";
  return null;
}

export function reviewVerdictFor(mode: TaskMode | string, result: CouncilResult | null): ReviewVerdict | null {
  if (!result) return null;
  if (result.reviewVerdict) return result.reviewVerdict;
  if (mode === "REVIEW") return reviewVerdictFromStatus(result.finalEnforcedStatus ?? result.status);
  return null;
}

export function artifactStatusForReview(verdict: ReviewVerdict | null, councilStatus: CouncilStatus): "APPROVED" | "BLOCKED" | "READY_FOR_REVIEW" | "DRAFT" {
  if (verdict === "PASS" || councilStatus === "APPROVED") return "APPROVED";
  if (verdict === "BLOCKED" || councilStatus === "BLOCKED") return "BLOCKED";
  if (verdict === "PATCH" || councilStatus === "PATCH") return "READY_FOR_REVIEW";
  return "DRAFT";
}
