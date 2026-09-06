import type { CouncilMember } from "./members.ts";
import { findMember } from "./members.ts";
import { isCouncilRole, normalizeAgentKey, type CouncilRole } from "./roles.ts";
import type { AgentKey, AgentProgress, AgentResponse, CouncilCallStage } from "./types.ts";

export const MIN_SURVIVING_AGENTS = 2;

export function responseMemberId(row: Pick<AgentResponse, "memberId" | "agent">): string {
  return String(row.memberId || row.agent || "").trim();
}

export function isSynthesisResponse(row: Pick<AgentResponse, "stage" | "round">): boolean {
  return row.stage === "SYNTHESIS" || row.round === 3;
}

export function stageOfRound(round: 1 | 2 | 3): CouncilCallStage {
  if (round === 3) return "SYNTHESIS";
  if (round === 2) return "ROUND_2";
  return "ROUND_1";
}

export function roundOfStage(stage: CouncilCallStage): 1 | 2 | 3 {
  if (stage === "SYNTHESIS") return 3;
  if (stage === "ROUND_2") return 2;
  return 1;
}

export function survivingResponses(rows: AgentResponse[]): AgentResponse[] {
  return rows.filter((row) => !row.error);
}

export function failedResponses(rows: AgentResponse[]): AgentResponse[] {
  return rows.filter((row) => Boolean(row.error));
}

export function councilAgentFailure(rows: AgentResponse[]): string | null {
  const partial = councilPartial(rows);
  if (partial.ok) return null;
  return failedResponses(rows)[0]?.error ?? partial.reason;
}

export function councilPartial(rows: AgentResponse[]): {
  ok: boolean;
  survivors: AgentResponse[];
  failed: AgentResponse[];
  reason: string;
  retryAgents: AgentKey[];
} {
  const survivors = survivingResponses(rows);
  const failed = failedResponses(rows);
  const retryAgents = [...new Set(failed.map((row) => responseMemberId(row)).filter(Boolean))];
  if (survivors.length >= MIN_SURVIVING_AGENTS) {
    return { ok: true, survivors, failed, reason: "", retryAgents };
  }
  const details = failed
    .map((row) => row.error)
    .filter((text): text is string => Boolean(text));
  const reason =
    survivors.length === 0
      ? `Synthesis was not created. No Council model produced a usable response. ${details.join(" ")}`.trim()
      : `Synthesis was not created. Only ${survivors.length} of ${MIN_SURVIVING_AGENTS} required models survived. ${details.join(" ")}`.trim();
  return { ok: false, survivors, failed, reason, retryAgents };
}

export function synthesizerQueue(
  rows: AgentResponse[],
  members: CouncilMember[] = [],
  override = "",
): CouncilMember[] {
  const aliveIds = new Set(survivingResponses(rows).map((row) => responseMemberId(row)));
  const selected = members.filter((row) => aliveIds.has(row.memberId));
  const ordered: CouncilMember[] = [];
  const preferred = override.trim();
  if (preferred) {
    const match = selected.find((row) => row.modelId === preferred);
    if (match) ordered.push(match);
  }
  for (const member of selected) {
    if (!ordered.some((row) => row.memberId === member.memberId)) ordered.push(member);
  }
  return ordered;
}

export function synthesizerAgent(
  rows: AgentResponse[],
  members: CouncilMember[] = [],
  override = "",
): AgentKey {
  const queue = synthesizerQueue(rows, members, override);
  if (queue[0]) return queue[0].memberId;
  const alive = survivingResponses(rows)[0];
  if (alive) {
    return findMember(members, alive)?.memberId ?? responseMemberId(alive);
  }
  return members[0]?.memberId ?? "";
}

export function fillResponse(
  row: Partial<AgentResponse> & { agent: AgentKey; taskId: string },
): AgentResponse {
  const memberId = row.memberId || row.agent;
  const round = row.round ?? 1;
  const role: CouncilRole = row.role ?? (isCouncilRole(row.agent) ? row.agent : normalizeAgentKey(row.agent));
  const model = row.model ?? "m";
  return {
    id: row.id ?? `${memberId}-${round}`,
    taskId: row.taskId,
    memberId,
    agent: memberId,
    role,
    round,
    stage: row.stage ?? stageOfRound(round),
    model,
    dispatchedModelId: row.dispatchedModelId ?? model,
    provider: row.provider ?? "openrouter",
    promptSnapshot: row.promptSnapshot ?? "",
    responseText: row.responseText ?? (row.error ? "" : "ok"),
    structured: row.structured ?? null,
    inputTokens: row.inputTokens ?? null,
    cachedInputTokens: row.cachedInputTokens ?? null,
    outputTokens: row.outputTokens ?? null,
    reasoningTokens: row.reasoningTokens ?? null,
    cost: row.cost ?? null,
    requestId: row.requestId ?? null,
    latencyMs: row.latencyMs ?? null,
    attempt: row.attempt ?? null,
    error: row.error ?? null,
    contextManifestId: row.contextManifestId ?? null,
    contextHash: row.contextHash ?? null,
    runId: row.runId ?? null,
  };
}

export function formatAgentCard(
  label: string,
  row: Pick<AgentProgress, "state" | "attempt" | "maxAttempts" | "error">,
): {
  title: string;
  status: string;
  attempts: string;
  lastError: string | null;
} {
  return {
    title: label,
    status: row.state,
    attempts: `attempts ${row.attempt}/${row.maxAttempts}`,
    lastError: row.state === "FAILED" ? row.error : null,
  };
}
