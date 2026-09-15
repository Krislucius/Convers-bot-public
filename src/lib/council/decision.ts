import { stripFindingDecor, unresolvedBlockers } from "./issues.ts";
import { isTaskMode, normalizeTaskMode } from "./task-mode.ts";
import type { CouncilResult, CouncilStatus, TaskMode } from "./types.ts";

export const NEXT_ACTIONS = [
  "ACCEPT",
  "CREATE PATCH",
  "RUN REVIEW",
  "RUN DECIDE",
  "REQUEST MORE EVIDENCE",
] as const;

export type NextAction = (typeof NEXT_ACTIONS)[number];

export type RunStatus = "COMPLETE" | "FAILED" | "CANCELLED";

export type DecisionBlocker = {
  issueId: string;
  title: string;
  severity: "P0";
  why: string;
  evidenceRefs: string[];
  supportingRoles: string[];
  opposingRoles: string[];
  resolveCondition: string;
};

export type DecisionResolved = {
  issueId: string;
  title: string;
  disposition: "RESOLVED" | "REJECTED" | "ACCEPTED_AS_PATCH";
  reason: string;
};

export type DecisionRecord = {
  runStatus: RunStatus | null;
  verdict: CouncilStatus | null;
  conclusion: string;
  why: string;
  agreed: string[];
  blockers: DecisionBlocker[];
  resolved: DecisionResolved[];
  userDecisions: string[];
  nextAction: NextAction | null;
  nextActionWhy: string;
};

const P0_WHY = "Unresolved P0. Acceptance requires this issue to be resolved or rejected.";

export function shortTitle(text: string): string {
  const cleaned = stripFindingDecor(text).replace(/\s+/g, " ").trim();
  if (!cleaned) return "Untitled issue";
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  if (sentence.length <= 90) return sentence;
  return `${sentence.slice(0, 87).trimEnd()}…`;
}

function unique(rows: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const text = String(row ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function firstSentence(text: string): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const sentence = cleaned.split(/(?<=[.!?])\s+/)[0] ?? cleaned;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
}

function overlap(a: string, b: string): boolean {
  const left = a.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3);
  const right = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3));
  if (!left.length || !right.size) return false;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits >= 2;
}

function evidenceRefs(issueText: string, result: CouncilResult): string[] {
  const fromText = issueText.match(/\[[A-Z]+:[^\]]+\]/g) ?? [];
  const fromLabels = result.evidence
    .filter((row) => overlap(row.claim, issueText) || (row.citation && issueText.includes(row.citation)))
    .map((row) => row.citation)
    .filter((row): row is string => Boolean(row));
  const fromCitations = result.citations.filter((row) => issueText.includes(row) || overlap(issueText, row));
  return unique([...fromText, ...fromLabels, ...fromCitations]).slice(0, 6);
}

function rolesFrom(issue: { sources: Array<{ memberId: string; heading: string }> }, headings: string[]): string[] {
  const want = new Set(headings.map((row) => row.toUpperCase()));
  return unique(
    issue.sources.filter((src) => want.has(src.heading.toUpperCase())).map((src) => src.memberId),
  );
}

function isEvidenceGap(result: CouncilResult): boolean {
  if (result.evidence.some((row) => row.status === "CONFLICTED")) return true;
  if (result.blockers.some((row) => /evidence|citation|unattested|source missing|no citation/i.test(row))) return true;
  return false;
}

export function nextActionFor(input: {
  mode: TaskMode;
  runStatus: RunStatus | null;
  verdict: CouncilStatus | null;
  result: CouncilResult | null;
}): { action: NextAction | null; why: string } {
  if (!input.verdict || !input.result) {
    return { action: null, why: "Council did not produce a task verdict." };
  }
  if (input.verdict === "USER_DECISION_REQUIRED") {
    return { action: "RUN DECIDE", why: "An operator choice is required before work can continue." };
  }
  if (input.verdict === "BLOCKED") {
    if (isEvidenceGap(input.result)) {
      return { action: "REQUEST MORE EVIDENCE", why: "Unresolved P0 depends on missing or conflicted evidence." };
    }
    return { action: "CREATE PATCH", why: "Unresolved P0 must be fixed before the result can be accepted." };
  }
  if (input.verdict === "PATCH") {
    return { action: "CREATE PATCH", why: "A material fix is required; no P0 remains." };
  }
  if (input.mode === "CREATE") {
    return { action: "RUN REVIEW", why: "The reconstructed artifact is ready for a REVIEW Council." };
  }
  return { action: "ACCEPT", why: "No unresolved blocking issues remain." };
}

export function deriveDecisionRecord(input: {
  mode: TaskMode | string;
  runStatus: RunStatus | null;
  result: CouncilResult | null;
}): DecisionRecord {
  const mode = isTaskMode(input.mode) ? input.mode : normalizeTaskMode(input.mode);
  const result =
    input.runStatus === "FAILED" || input.runStatus === "CANCELLED" ? null : input.result;
  const verdict = result?.reconciledStatus ?? result?.finalEnforcedStatus ?? result?.status ?? null;
  const ledger = result?.issueLedger ?? null;
  const p0 = ledger && verdict === "BLOCKED" ? unresolvedBlockers(ledger, mode) : [];

  const blockers: DecisionBlocker[] = p0.map((issue) => ({
    issueId: issue.issueId,
    title: shortTitle(issue.text),
    severity: "P0",
    why: P0_WHY,
    evidenceRefs: result ? evidenceRefs(issue.text, result) : [],
    supportingRoles: rolesFrom(issue, ["REMAINING_P0", "P0_BLOCKERS", "UNRESOLVED_ISSUES"]),
    opposingRoles: rolesFrom(issue, ["REJECTED_OBJECTIONS", "RESOLVED"]),
    resolveCondition: `Resolve or reject ${issue.issueId}: REMAINING_P0 must be none or REJECTED_OBJECTIONS must list it, then re-run Council.`,
  }));

  const resolved: DecisionResolved[] = [];
  if (ledger) {
    for (const issue of ledger.resolved) {
      resolved.push({
        issueId: issue.issueId,
        title: shortTitle(issue.text),
        disposition: "RESOLVED",
        reason: "Raised in debate, then closed.",
      });
    }
    for (const issue of ledger.rejected) {
      resolved.push({
        issueId: issue.issueId,
        title: shortTitle(issue.text),
        disposition: "REJECTED",
        reason: "Raised, then rejected by reviewers.",
      });
    }
    for (const issue of ledger.acceptedAsPatch.filter((row) => row.severity !== "P4")) {
      resolved.push({
        issueId: issue.issueId,
        title: shortTitle(issue.text),
        disposition: "ACCEPTED_AS_PATCH",
        reason: "Accepted as a correction, not a remaining blocker.",
      });
    }
  }

  const agreed = unique([
    ...(result?.consensus ?? []),
    result?.recommendation ? firstSentence(result.recommendation) : "",
    ...resolved.filter((row) => row.disposition === "RESOLVED").map((row) => row.title),
  ]).slice(0, 7);

  const userDecisions =
    verdict === "USER_DECISION_REQUIRED"
      ? unique([
          ...(ledger?.userDecision ?? []).map((row) => shortTitle(row.text)),
          ...(result?.disagreements ?? []),
          result?.decision ? firstSentence(result.decision) : "",
        ]).slice(0, 7)
      : [];

  let why = "Council did not produce a synthesis.";
  let conclusion = "No task verdict — Council did not finish.";
  if (verdict === "BLOCKED") {
    why = "Unresolved P0 findings remain.";
    conclusion = firstSentence(result?.recommendation ?? "") || "Cannot accept: unresolved P0 remains.";
  } else if (verdict === "PATCH") {
    why = "A material fix is required; no P0 remains.";
    conclusion = firstSentence(result?.recommendation ?? "") || "Apply the listed corrections, then re-run REVIEW.";
  } else if (verdict === "USER_DECISION_REQUIRED") {
    why = "A choice remains that only the operator can make.";
    conclusion = firstSentence(result?.decision || result?.recommendation || "") || "Council needs an operator choice.";
  } else if (verdict === "APPROVED") {
    why = "No unresolved blocking issues remain.";
    conclusion =
      firstSentence(result?.recommendation ?? "") ||
      (mode === "CREATE" ? "The reconstructed artifact is accepted." : "The candidate is accepted.");
  } else if (input.runStatus === "FAILED") {
    why = "Council failed before synthesis.";
    conclusion = "No task verdict — Council did not finish.";
  } else if (input.runStatus === "CANCELLED") {
    why = "The run was cancelled before synthesis.";
    conclusion = "No task verdict — Council was cancelled.";
  }

  const next = nextActionFor({ mode, runStatus: input.runStatus, verdict, result });

  return {
    runStatus: input.runStatus,
    verdict,
    conclusion,
    why,
    agreed: agreed.slice(0, 7),
    blockers,
    resolved,
    userDecisions,
    nextAction: next.action,
    nextActionWhy: next.why,
  };
}

export function blockerWhyIsNormalized(record: DecisionRecord): boolean {
  return record.blockers.every((row) => row.why === P0_WHY);
}
