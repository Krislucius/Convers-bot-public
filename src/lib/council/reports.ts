import { councilPartial, isSynthesisResponse, responseMemberId } from "./agents.ts";
import { classifyErrorClass } from "./provider-error.ts";
import { isEmptyFinding } from "./issues.ts";
import { isNonBlockingCreateFinding, isTaskMode, normalizeTaskMode } from "./task-mode.ts";
import type {
  AgentProgress,
  AgentResponse,
  Artifact,
  CouncilMember,
  CouncilResult,
  TaskMode,
  TaskStatus,
} from "./types.ts";

export type TechnicalKind = "RUNNING" | "FINISHED" | "FINISHED_WITH_GAPS" | "FAILED" | "CANCELLED";
export type SubstanceKind = "NONE" | "CREATED" | "ACCEPTED" | "NEEDS_PATCH" | "CANNOT_ACCEPT" | "NEEDS_DECISION";
export type MemberFailKind =
  | "connection"
  | "timeout"
  | "unavailable"
  | "empty"
  | "rate_limited"
  | "auth"
  | "payment"
  | "refusal"
  | "role"
  | "aborted"
  | "provider";

export type MemberOutcome = {
  memberId: string;
  label: string;
  role: string | null;
  outcome: "completed" | "failed" | "running" | "waiting" | "skipped";
  reason: string | null;
  failKind: MemberFailKind | null;
};

export type TechnicalReport = {
  kind: TechnicalKind;
  headline: string;
  summary: string;
  members: MemberOutcome[];
  synthesis: "recorded" | "failed" | "skipped" | "pending";
};

export type SubstanceReport = {
  kind: SubstanceKind;
  headline: string;
  summary: string;
  created: string | null;
  discussed: string[];
  next: string[];
  cannotAccept: string[];
};

export type CouncilReports = {
  technical: TechnicalReport;
  substance: SubstanceReport;
};

const STATUS_LABEL: Record<string, string> = {
  BLOCKED: "Not accepted",
  USER_DECISION_REQUIRED: "Needs your decision",
  APPROVED: "Accepted",
  PATCH: "Needs a patch",
  PASS: "Accepted",
  READY_FOR_REVIEW: "Ready for review",
  SUPERSEDED: "Superseded",
  DRAFT: "Draft",
  COMPLETE: "Complete",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

export function humanStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? "").trim();
  if (!key) return "";
  return STATUS_LABEL[key] ?? key.replaceAll("_", " ");
}

export function reportsContainBlocked(value: unknown): boolean {
  return /\bBLOCKED\b/.test(JSON.stringify(value ?? ""));
}

export function decodeMemberFailure(
  error: string | null | undefined,
  httpStatus?: number | null,
): { kind: MemberFailKind; label: string } {
  const raw = String(error ?? "").trim();
  const classified = classifyErrorClass(httpStatus ?? null, raw);
  const low = raw.toLowerCase();
  if (classified.errorClass === "TIMEOUT" || classified.httpClass === "timeout") {
    return { kind: "timeout", label: "Timed out waiting for the model" };
  }
  if (classified.errorClass === "NETWORK_ERROR" || classified.httpClass === "network") {
    return { kind: "connection", label: "Could not connect to the provider" };
  }
  if (classified.errorClass === "MODEL_UNAVAILABLE") {
    return { kind: "unavailable", label: "Model is unavailable or not included in this plan" };
  }
  if (/unavailable|not included|model_not_included/i.test(raw)) {
    return { kind: "unavailable", label: "Model is unavailable or not included in this plan" };
  }
  if (classified.errorClass === "EMPTY_RESPONSE" || classified.httpClass === "empty") {
    return { kind: "empty", label: "Model returned an empty response" };
  }
  if (classified.errorClass === "RATE_LIMITED" || classified.httpClass === "429") {
    return { kind: "rate_limited", label: "Rate limited by the provider" };
  }
  if (classified.errorClass === "ABORTED") {
    return { kind: "aborted", label: "Request was aborted" };
  }
  if (classified.errorClass === "STREAM_INTERRUPTED") {
    return { kind: "connection", label: "Response stream was interrupted" };
  }
  if (classified.httpClass === "401") {
    return { kind: "auth", label: "Provider rejected the API key" };
  }
  if (classified.httpClass === "402") {
    return { kind: "payment", label: "Provider required payment or quota" };
  }
  if (/refus|won't comply|will not comply|cannot comply|content filter|safety policy|i cannot (help|assist)/i.test(low)) {
    return { kind: "refusal", label: "Model refused the assigned task" };
  }
  if (/role|not (a |the )?reviewer|wrong role|does not match (the )?role/i.test(low)) {
    return { kind: "role", label: "Model did not follow its assigned role" };
  }
  if (classified.httpClass === "5xx") {
    return { kind: "provider", label: "Provider returned a server error" };
  }
  if (raw) {
    const clipped = raw.length > 180 ? `${raw.slice(0, 177)}…` : raw;
    return { kind: "provider", label: clipped };
  }
  return { kind: "provider", label: "The request did not complete" };
}

function memberOutcome(
  member: { memberId: string; label: string; role?: string },
  agents: Partial<Record<string, AgentProgress>>,
  responses: AgentResponse[],
): MemberOutcome {
  const rows = responses.filter((row) => responseMemberId(row) === member.memberId && !isSynthesisResponse(row));
  const progress = agents[member.memberId];
  const state = progress?.state;
  if (state === "RUNNING") {
    return { memberId: member.memberId, label: member.label, role: member.role ?? null, outcome: "running", reason: null, failKind: null };
  }
  if (state === "WAITING" && !rows.length) {
    return { memberId: member.memberId, label: member.label, role: member.role ?? null, outcome: "waiting", reason: null, failKind: null };
  }
  const failedRow = rows.find((row) => row.error);
  if (state === "FAILED" || failedRow) {
    const decoded = decodeMemberFailure(progress?.error ?? failedRow?.error, progress?.httpStatus);
    return {
      memberId: member.memberId,
      label: member.label,
      role: member.role ?? null,
      outcome: "failed",
      reason: decoded.label,
      failKind: decoded.kind,
    };
  }
  if (state === "DONE" || rows.some((row) => !row.error && row.responseText)) {
    return { memberId: member.memberId, label: member.label, role: member.role ?? null, outcome: "completed", reason: null, failKind: null };
  }
  return { memberId: member.memberId, label: member.label, role: member.role ?? null, outcome: "skipped", reason: "Did not produce a recorded response", failKind: null };
}

function uniqueTexts(rows: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    const text = String(row ?? "").trim();
    if (!text || isEmptyFinding(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function followUps(result: CouncilResult | null, mode: TaskMode): string[] {
  if (!result) return [];
  const ledger = result.issueLedger;
  const fromLedger = [
    ...(ledger?.unresolved ?? []).filter((row) => row.severity !== "P0" && (mode === "CREATE" || row.severity !== "P1")),
    ...(ledger?.acceptedAsPatch ?? []),
    ...(mode === "CREATE" ? (ledger?.resolved ?? []).filter((row) => row.severity === "P1" || isNonBlockingCreateFinding(row.text)) : []),
  ].map((row) => row.text);
  return uniqueTexts([
    ...fromLedger,
    ...result.proposedCorrections,
    ...result.issues,
    ...result.unresolvedIssues.filter((row) => !result.blockers.includes(row)),
  ]).slice(0, 12);
}

function discussed(result: CouncilResult | null): string[] {
  if (!result) return [];
  return uniqueTexts([...result.consensus, result.recommendation ? result.recommendation : "", ...result.disagreements]).slice(0, 8);
}

export function deriveCouncilReports(input: {
  mode: TaskMode | string;
  terminal: "COMPLETE" | "FAILED" | "CANCELLED" | null;
  taskStatus: TaskStatus | string;
  result: CouncilResult | null;
  artifact?: Artifact | null;
  responses?: AgentResponse[];
  agents?: Partial<Record<string, AgentProgress>>;
  members?: Array<Pick<CouncilMember, "memberId" | "label"> & { role?: string }>;
  running?: boolean;
}): CouncilReports {
  const mode = isTaskMode(input.mode) ? input.mode : normalizeTaskMode(input.mode);
  const responses = input.responses ?? [];
  const agents = input.agents ?? {};
  const members = (input.members?.length
    ? input.members
    : [...new Set(responses.filter((row) => !isSynthesisResponse(row)).map((row) => responseMemberId(row)))]
        .filter(Boolean)
        .map((memberId) => ({ memberId, label: memberId }))
  ) as Array<{ memberId: string; label: string; role?: string }>;
  const outcomes = members.map((member) => memberOutcome(member, agents, responses));
  const failed = outcomes.filter((row) => row.outcome === "failed");
  const completed = outcomes.filter((row) => row.outcome === "completed");
  const synthRow = responses.find((row) => isSynthesisResponse(row));
  const synthOk = Boolean(input.result) || Boolean(synthRow && !synthRow.error);
  const synthFailed = Boolean(synthRow?.error) && !input.result;
  const workRows = responses.filter((row) => !isSynthesisResponse(row));
  const partial = councilPartial(workRows);
  let synthesis: TechnicalReport["synthesis"] = "pending";
  if (synthOk) synthesis = "recorded";
  else if (synthFailed) synthesis = "failed";
  else if (input.terminal === "FAILED" || input.taskStatus === "FAILED") synthesis = "skipped";

  let kind: TechnicalKind;
  let headline: string;
  let summary: string;
  if (input.terminal === "CANCELLED" || input.taskStatus === "CANCELLED") {
    kind = "CANCELLED";
    headline = "Council cancelled";
    summary = "The run was stopped before an official task verdict.";
  } else if (input.running && !input.terminal) {
    kind = "RUNNING";
    headline = "Council is running";
    summary = "Members are still working. Task verdict appears when synthesis finishes.";
  } else if (input.terminal === "FAILED" || (input.taskStatus === "FAILED" && !synthOk)) {
    kind = "FAILED";
    headline = "Council failed";
    if (!partial.ok) summary = partial.reason || "Synthesis was not created because too few models survived.";
    else if (synthFailed) summary = synthRow?.error ? decodeMemberFailure(synthRow.error).label : "Synthesis did not complete.";
    else summary = "The run ended without a recorded synthesis.";
  } else if (synthOk) {
    if (failed.length) {
      kind = "FINISHED_WITH_GAPS";
      headline = "Council finished with gaps";
      summary = `Synthesis was recorded. ${completed.length} of ${outcomes.length || completed.length + failed.length} members completed their roles; ${failed.length} did not.`;
    } else {
      kind = "FINISHED";
      headline = "Council finished successfully";
      summary =
        outcomes.length === 0
          ? "Synthesis was recorded."
          : `All ${completed.length || outcomes.length} selected models completed their roles. Synthesis was recorded.`;
    }
  } else if (input.terminal === "COMPLETE") {
    kind = "FAILED";
    headline = "Council failed";
    summary = "The run ended without a recorded synthesis.";
  } else {
    kind = "RUNNING";
    headline = "Council is running";
    summary = "Members are still working. Task verdict appears when synthesis finishes.";
  }

  if (kind === "FAILED" && failed.length) {
    const decoded = failed.map((row) => `${row.label}: ${row.reason ?? "failed"}`).join(" ");
    summary = `${summary} ${decoded}`.trim();
  }

  const technical: TechnicalReport = { kind, headline, summary, members: outcomes, synthesis };

  const result = input.result;
  const verdict = result?.reconciledStatus ?? result?.finalEnforcedStatus ?? result?.status ?? null;
  const review = result?.reviewVerdict ?? null;
  const artifactTitle = input.artifact?.title?.trim() || null;
  let substance: SubstanceReport;
  if (!result) {
    substance = {
      kind: "NONE",
      headline: "No task verdict yet",
      summary:
        kind === "FAILED"
          ? "Council did not finish, so there is no official verdict on the task."
          : kind === "CANCELLED"
            ? "The run was cancelled, so there is no official verdict on the task."
            : "Task verdict appears after synthesis.",
      created: null,
      discussed: [],
      next: [],
      cannotAccept: [],
    };
  } else if (verdict === "USER_DECISION_REQUIRED") {
    substance = {
      kind: "NEEDS_DECISION",
      headline: "Needs your decision",
      summary: result.decision?.trim() || result.recommendation || "Council could not close the decision without you.",
      created: artifactTitle,
      discussed: discussed(result),
      next: uniqueTexts([...result.disagreements, ...result.dissent, ...followUps(result, mode)]),
      cannotAccept: [],
    };
  } else if (verdict === "BLOCKED" || review === "BLOCKED") {
    const cannotAccept = uniqueTexts([
      ...result.blockers,
      ...(result.issueLedger?.unresolved ?? []).filter((row) => row.severity === "P0" || (mode !== "CREATE" && row.severity === "P1")).map((row) => row.text),
      ...result.unresolvedIssues.filter((row) => /p0|invariant|violat/i.test(row)),
    ]);
    substance = {
      kind: "CANNOT_ACCEPT",
      headline: "Cannot accept this result",
      summary:
        cannotAccept.length
          ? "Council finished, but unresolved invariants remain. Those are the reasons this result cannot be accepted."
          : "Council finished, but the safety gate cannot accept this result.",
      created: artifactTitle,
      discussed: discussed(result),
      next: followUps(result, mode),
      cannotAccept,
    };
  } else if (mode === "REVIEW" && (review === "PATCH" || verdict === "PATCH")) {
    substance = {
      kind: "NEEDS_PATCH",
      headline: "Needs a patch to continue",
      summary: result.recommendation || "Council accepted the candidate only after the listed corrections.",
      created: artifactTitle,
      discussed: discussed(result),
      next: uniqueTexts([...result.proposedCorrections, ...followUps(result, mode)]),
      cannotAccept: [],
    };
  } else if (mode === "CREATE") {
    substance = {
      kind: "CREATED",
      headline: artifactTitle ? `Created ${artifactTitle}` : "Reconstruction complete",
      summary: result.recommendation || "Council produced the requested artifact from the selected evidence.",
      created: artifactTitle,
      discussed: discussed(result),
      next: followUps(result, mode),
      cannotAccept: [],
    };
  } else if (mode === "DECIDE") {
    substance = {
      kind: "ACCEPTED",
      headline: result.decision?.trim() ? `Decision: ${result.decision.trim()}` : "Decision recorded",
      summary: result.rationale || result.recommendation || "Council recorded a decision.",
      created: artifactTitle,
      discussed: discussed(result),
      next: followUps(result, mode),
      cannotAccept: [],
    };
  } else {
    substance = {
      kind: "ACCEPTED",
      headline: "Candidate accepted",
      summary: result.recommendation || "Council accepted the candidate.",
      created: artifactTitle,
      discussed: discussed(result),
      next: followUps(result, mode),
      cannotAccept: [],
    };
  }

  return { technical, substance };
}
