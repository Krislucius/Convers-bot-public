import { hashContent } from "../history/hash.ts";
import { isNonBlockingCreateFinding, isTaskMode, normalizeTaskMode } from "./task-mode.ts";
import type { AgentResponse, CouncilStatus, TaskMode } from "./types.ts";

export const ISSUE_DISPOSITIONS = [
  "UNRESOLVED",
  "RESOLVED",
  "REJECTED",
  "ACCEPTED_AS_PATCH",
  "USER_DECISION_REQUIRED",
] as const;

export type IssueDisposition = (typeof ISSUE_DISPOSITIONS)[number];

export type IssueSeverity = "P0" | "P1" | "P2" | "P3" | "P4" | "UNKNOWN";

export type IssueSource = {
  memberId: string;
  heading: string;
  round: 1 | 2 | 3;
};

export type NormalizedIssue = {
  issueId: string;
  text: string;
  severity: IssueSeverity;
  disposition: IssueDisposition;
  sources: IssueSource[];
};

export type IssueLedger = {
  issues: NormalizedIssue[];
  unresolved: NormalizedIssue[];
  resolved: NormalizedIssue[];
  rejected: NormalizedIssue[];
  acceptedAsPatch: NormalizedIssue[];
  userDecision: NormalizedIssue[];
};

export type GateResult = {
  status: CouncilStatus;
  blockers: string[];
  reason: string | null;
  proposedStatus: CouncilStatus;
  reconciledStatus: CouncilStatus;
  ledger: IssueLedger;
};

const EMPTY = new Set(["none", "n/a", "na", "-", "nil", "null", "no items", "n.a.", "n.a", ""]);

export function isEmptyFinding(text: string | null | undefined): boolean {
  const line = String(text ?? "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()
    .toLowerCase();
  return !line || EMPTY.has(line);
}

export function splitFindingLines(body: string | null | undefined): string[] {
  const raw = String(body ?? "");
  if (!raw.trim() || isEmptyFinding(raw)) return [];
  return raw
    .split(/\n+|(?:;\s+)/)
    .map((line) =>
      line
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim(),
    )
    .filter((line) => line && !isEmptyFinding(line));
}

export function normalizeIssueKey(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/^(p[0-4]|blocker|issue|remaining|objection)[:.\-\s]+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function issueIdFor(text: string): string {
  const key = normalizeIssueKey(text) || "empty";
  const hash = hashContent(key).split(":")[0] ?? hashContent(key);
  return `iss_${hash.slice(0, 12)}`;
}

function sameIssue(a: string, b: string): boolean {
  const left = normalizeIssueKey(a);
  const right = normalizeIssueKey(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 8 && right.length >= 8 && (left.includes(right) || right.includes(left))) return true;
  const leftTokens = new Set(left.split(" ").filter((row) => row.length > 3));
  const rightTokens = new Set(right.split(" ").filter((row) => row.length > 3));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  const min = Math.min(leftTokens.size, rightTokens.size);
  return min >= 2 && overlap / min >= 0.7;
}

function bumpSeverity(current: IssueSeverity, next: IssueSeverity): IssueSeverity {
  const rank: Record<IssueSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4, UNKNOWN: 5 };
  return rank[next] < rank[current] ? next : current;
}

function findMatch(issues: NormalizedIssue[], text: string): NormalizedIssue | null {
  const id = issueIdFor(text);
  return issues.find((row) => row.issueId === id || sameIssue(row.text, text)) ?? null;
}

function upsert(
  issues: NormalizedIssue[],
  text: string,
  severity: IssueSeverity,
  disposition: IssueDisposition,
  source: IssueSource,
): NormalizedIssue {
  const existing = findMatch(issues, text);
  if (existing) {
    existing.severity = bumpSeverity(existing.severity, severity);
    existing.disposition = disposition;
    existing.sources.push(source);
    if (existing.text.length < text.trim().length) existing.text = text.trim();
    return existing;
  }
  const created: NormalizedIssue = {
    issueId: issueIdFor(text),
    text: text.trim(),
    severity,
    disposition,
    sources: [source],
  };
  issues.push(created);
  return created;
}

function headingPresent(structured: Record<string, string>, heading: string): boolean {
  return Object.prototype.hasOwnProperty.call(structured, heading);
}

function residualBody(structured: Record<string, string>, remaining: string, historic: string): string {
  if (headingPresent(structured, remaining)) return structured[remaining] ?? "";
  return structured[historic] ?? "";
}

function lastSourceRound(issue: NormalizedIssue): number {
  return issue.sources.reduce((max, src) => Math.max(max, src.round), 0);
}

function closeRemaining(
  issues: NormalizedIssue[],
  remaining: string[],
  severity: "P0" | "P1",
): void {
  for (const line of remaining) {
    const match = findMatch(issues, line);
    if (match) {
      match.disposition = "UNRESOLVED";
      match.severity = bumpSeverity(match.severity, severity);
    }
  }
  for (const issue of issues) {
    if (issue.severity !== severity) continue;
    if (issue.disposition === "REJECTED" || issue.disposition === "ACCEPTED_AS_PATCH") continue;
    const still = remaining.some((line) => sameIssue(issue.text, line) || issueIdFor(line) === issue.issueId);
    if (!still && issue.disposition === "UNRESOLVED") issue.disposition = "RESOLVED";
  }
}

export type SynthIssueFields = {
  blockers?: string[];
  issues?: string[];
  resolvedIssues?: string[];
  unresolvedIssues?: string[];
  proposedCorrections?: string[];
  disagreements?: string[];
};

export function buildIssueLedger(input: {
  round2: AgentResponse[];
  round1?: AgentResponse[];
  parsed: SynthIssueFields;
  mode: TaskMode | string;
}): IssueLedger {
  const mode = isTaskMode(input.mode) ? input.mode : normalizeTaskMode(input.mode);
  const issues: NormalizedIssue[] = [];
  const rows = [...(input.round1 ?? []), ...input.round2];
  const remainingP0Union: string[] = [];
  const remainingP1Union: string[] = [];
  let sawRemainingP0 = false;
  let sawRemainingP1 = false;

  for (const row of rows) {
    const structured = row.structured ?? {};
    const memberId = String(row.memberId || row.agent || "unknown");
    const round: 1 | 2 = row.round === 2 || row.stage === "ROUND_2" ? 2 : 1;
    const isRound2 =
      round === 2 || headingPresent(structured, "REMAINING_P0") || headingPresent(structured, "REJECTED_OBJECTIONS");

    const p0Body = isRound2 ? residualBody(structured, "REMAINING_P0", "P0_BLOCKERS") : (structured.P0_BLOCKERS ?? "");
    for (const line of splitFindingLines(p0Body)) {
      upsert(issues, line, "P0", "UNRESOLVED", { memberId, heading: isRound2 ? "REMAINING_P0" : "P0_BLOCKERS", round });
    }

    const p1Body = isRound2
      ? residualBody(structured, "REMAINING_P1", "P1_ARCHITECTURE")
      : (structured.P1_ARCHITECTURE ?? "");
    if (mode !== "CREATE") {
      for (const line of splitFindingLines(p1Body)) {
        upsert(issues, line, "P1", "UNRESOLVED", { memberId, heading: isRound2 ? "REMAINING_P1" : "P1_ARCHITECTURE", round });
      }
    } else {
      for (const line of splitFindingLines(p1Body)) {
        upsert(issues, line, "P1", "RESOLVED", { memberId, heading: isRound2 ? "REMAINING_P1" : "P1_ARCHITECTURE", round });
      }
    }

    for (const line of splitFindingLines(structured.P2_CORRECTNESS)) {
      upsert(issues, line, "P2", "UNRESOLVED", { memberId, heading: "P2_CORRECTNESS", round });
    }
    for (const line of splitFindingLines(structured.P3_ROBUSTNESS)) {
      upsert(issues, line, "P3", "UNRESOLVED", { memberId, heading: "P3_ROBUSTNESS", round });
    }
    for (const line of splitFindingLines(structured.P4_IMPROVEMENTS)) {
      upsert(issues, line, "P4", "UNRESOLVED", { memberId, heading: "P4_IMPROVEMENTS", round });
    }

    if (isRound2) {
      for (const line of splitFindingLines(structured.REJECTED_OBJECTIONS)) {
        const match = findMatch(issues, line);
        if (match) {
          match.disposition = "REJECTED";
          match.sources.push({ memberId, heading: "REJECTED_OBJECTIONS", round: 2 });
        } else {
          upsert(issues, line, "UNKNOWN", "REJECTED", { memberId, heading: "REJECTED_OBJECTIONS", round: 2 });
        }
      }
      for (const line of splitFindingLines(structured.ACCEPTED_OBJECTIONS)) {
        const match = findMatch(issues, line);
        if (match) {
          match.disposition = "ACCEPTED_AS_PATCH";
          match.sources.push({ memberId, heading: "ACCEPTED_OBJECTIONS", round: 2 });
        } else {
          upsert(issues, line, "P2", "ACCEPTED_AS_PATCH", { memberId, heading: "ACCEPTED_OBJECTIONS", round: 2 });
        }
      }
      if (headingPresent(structured, "REMAINING_P0")) {
        sawRemainingP0 = true;
        remainingP0Union.push(...splitFindingLines(structured.REMAINING_P0));
      }
      if (headingPresent(structured, "REMAINING_P1")) {
        sawRemainingP1 = true;
        remainingP1Union.push(...splitFindingLines(structured.REMAINING_P1));
      }
    }
  }

  if (sawRemainingP0) closeRemaining(issues, remainingP0Union, "P0");
  if (sawRemainingP1 && mode !== "CREATE") closeRemaining(issues, remainingP1Union, "P1");

  const synthSource: IssueSource = { memberId: "SYNTHESIZER", heading: "SYNTHESIS", round: 3 };
  for (const line of splitFindingLines((input.parsed.proposedCorrections ?? []).join("\n"))) {
    const match = findMatch(issues, line);
    if (match) {
      if (match.severity !== "P0") match.disposition = "ACCEPTED_AS_PATCH";
      match.sources.push({ ...synthSource, heading: "PROPOSED_CORRECTIONS" });
    } else {
      upsert(issues, line, "P2", "ACCEPTED_AS_PATCH", { ...synthSource, heading: "PROPOSED_CORRECTIONS" });
    }
  }

  const unresolvedLines = [...(input.parsed.unresolvedIssues ?? []), ...(input.parsed.blockers ?? [])];
  for (const line of splitFindingLines(unresolvedLines.join("\n"))) {
    if (mode === "CREATE" && isNonBlockingCreateFinding(line)) continue;
    const match = findMatch(issues, line);
    const severity = /p0|blocker|invariant/i.test(line) ? "P0" : match?.severity ?? "UNKNOWN";
    if (mode === "CREATE" && (severity === "P1" || match?.severity === "P1")) {
      if (match && match.severity !== "P0") {
        match.disposition = "RESOLVED";
        match.sources.push({ ...synthSource, heading: "UNRESOLVED_ISSUES" });
      }
      continue;
    }
    if (match) {
      match.disposition = "UNRESOLVED";
      match.severity = bumpSeverity(match.severity, severity);
      match.sources.push({ ...synthSource, heading: "UNRESOLVED_ISSUES" });
    } else {
      upsert(issues, line, severity, "UNRESOLVED", { ...synthSource, heading: "UNRESOLVED_ISSUES" });
    }
  }

  for (const line of splitFindingLines((input.parsed.resolvedIssues ?? []).join("\n"))) {
    const match = findMatch(issues, line);
    if (match) {
      match.disposition = "RESOLVED";
      match.sources.push(synthSource);
    } else {
      upsert(issues, line, "UNKNOWN", "RESOLVED", synthSource);
    }
  }

  for (const line of splitFindingLines((input.parsed.issues ?? []).join("\n"))) {
    if (findMatch(issues, line)) continue;
    upsert(issues, line, "P2", "UNRESOLVED", { ...synthSource, heading: "ISSUES" });
  }

  for (const line of splitFindingLines((input.parsed.disagreements ?? []).join("\n"))) {
    if (mode !== "DECIDE") continue;
    const match = findMatch(issues, line);
    if (match) {
      if (match.disposition === "UNRESOLVED" && match.severity !== "P0" && match.severity !== "P1") {
        match.disposition = "USER_DECISION_REQUIRED";
      }
      match.sources.push({ ...synthSource, heading: "DISAGREEMENTS" });
    } else {
      upsert(issues, line, "UNKNOWN", "USER_DECISION_REQUIRED", { ...synthSource, heading: "DISAGREEMENTS" });
    }
  }

  if (mode === "CREATE") {
    for (const issue of issues) {
      if (issue.severity === "P1" && issue.disposition === "UNRESOLVED") issue.disposition = "RESOLVED";
      if (isNonBlockingCreateFinding(issue.text) && issue.disposition === "UNRESOLVED") {
        issue.disposition = "RESOLVED";
      }
    }
  }

  for (const issue of issues) {
    if (issue.disposition === "UNRESOLVED" && issue.severity === "P4") {
      issue.disposition = "ACCEPTED_AS_PATCH";
    }
  }

  const unique = new Map<string, NormalizedIssue>();
  for (const issue of issues) {
    const prev = unique.get(issue.issueId);
    if (!prev) {
      unique.set(issue.issueId, issue);
      continue;
    }
    prev.severity = bumpSeverity(prev.severity, issue.severity);
    prev.sources.push(...issue.sources);
    if (lastSourceRound(issue) >= lastSourceRound(prev)) prev.disposition = issue.disposition;
    if (issue.text.length > prev.text.length) prev.text = issue.text;
  }
  const merged = [...unique.values()];

  return {
    issues: merged,
    unresolved: merged.filter((row) => row.disposition === "UNRESOLVED"),
    resolved: merged.filter((row) => row.disposition === "RESOLVED"),
    rejected: merged.filter((row) => row.disposition === "REJECTED"),
    acceptedAsPatch: merged.filter((row) => row.disposition === "ACCEPTED_AS_PATCH"),
    userDecision: merged.filter((row) => row.disposition === "USER_DECISION_REQUIRED"),
  };
}

export function unresolvedBlockers(ledger: IssueLedger, mode: TaskMode | string): NormalizedIssue[] {
  const resolvedMode = isTaskMode(mode) ? mode : normalizeTaskMode(mode);
  return ledger.unresolved.filter((row) => {
    if (row.severity === "P0") return true;
    if (resolvedMode === "CREATE") return false;
    return row.severity === "P1";
  });
}

export function reconcileVerdict(input: {
  proposed: CouncilStatus;
  ledger: IssueLedger;
  mode: TaskMode | string;
  disagreements?: string[];
  conflictedEvidence?: boolean;
}): GateResult {
  const mode = isTaskMode(input.mode) ? input.mode : normalizeTaskMode(input.mode);
  const proposed = input.proposed;
  const blockers = unresolvedBlockers(input.ledger, mode);
  const blockerTexts = blockers.map((row) => row.text);
  const acceptedPatches = input.ledger.acceptedAsPatch.filter((row) => row.severity !== "P4");
  let status: CouncilStatus = proposed;
  let reason: string | null = null;

  const p0 = blockers.filter((row) => row.severity === "P0");
  const p1 = blockers.filter((row) => row.severity === "P1");

  if (p0.length) {
    status = "BLOCKED";
    if (proposed !== "BLOCKED") reason = "Safety gate: unresolved P0 findings require BLOCKED.";
  } else if (p1.length) {
    status = "BLOCKED";
    if (proposed !== "BLOCKED") reason = "Safety gate: unresolved P1 findings require BLOCKED.";
  } else if (mode === "DECIDE" && proposed === "APPROVED" && (Boolean(input.disagreements?.length) || input.conflictedEvidence)) {
    status = "USER_DECISION_REQUIRED";
    reason = "Safety gate: DECIDE disagreements or CONFLICTED evidence require USER_DECISION_REQUIRED.";
  } else if (mode === "REVIEW" && acceptedPatches.length && (proposed === "PATCH" || proposed === "BLOCKED")) {
    status = "PATCH";
    if (proposed === "BLOCKED") reason = "Safety gate: accepted non-P0 corrections reconcile to PATCH.";
  } else if (mode === "REVIEW" && proposed === "PATCH") {
    status = "PATCH";
  } else if (mode === "CREATE" && proposed === "BLOCKED") {
    status = "APPROVED";
    reason = "CREATE safety gate: no unresolved P0 findings remain; synthesizer BLOCKED is not the final verdict.";
  } else if (proposed === "BLOCKED") {
    status = mode === "REVIEW" && acceptedPatches.length ? "PATCH" : "APPROVED";
    reason =
      status === "PATCH"
        ? "Safety gate: no unresolved P0/P1 findings; accepted corrections reconcile to PATCH."
        : "Safety gate: no unresolved P0/P1 findings remain; synthesizer BLOCKED is not the final verdict.";
  } else if (proposed === "USER_DECISION_REQUIRED") {
    status = "USER_DECISION_REQUIRED";
  } else {
    status =
      proposed === "PATCH" && mode === "REVIEW"
        ? "PATCH"
        : proposed === "APPROVED" || proposed === "PATCH"
          ? mode === "CREATE"
            ? "APPROVED"
            : proposed
          : "APPROVED";
    if (mode === "CREATE" && proposed === "PATCH") status = "APPROVED";
  }

  if (!p0.length && !p1.length && status === "BLOCKED") {
    status = proposed === "USER_DECISION_REQUIRED" ? "USER_DECISION_REQUIRED" : "APPROVED";
  }

  return {
    status,
    blockers: status === "BLOCKED" ? blockerTexts : [],
    reason,
    proposedStatus: proposed,
    reconciledStatus: status,
    ledger: input.ledger,
  };
}
