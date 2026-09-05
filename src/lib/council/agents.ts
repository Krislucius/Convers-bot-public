import type { CouncilMember } from "./members.ts";
import type { AgentKey, AgentProgress, AgentResponse } from "./types.ts";

export const MIN_SURVIVING_AGENTS = 2;

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
  const retryAgents = [...new Set(failed.map((row) => row.agent))];
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

export function synthesizerAgent(
  rows: AgentResponse[],
  members: CouncilMember[] = [],
  override = "",
): AgentKey {
  const alive = survivingResponses(rows);
  const selected = new Set(members.map((row) => row.modelId));
  if (override && selected.has(override)) {
    const match = members.find((row) => row.modelId === override);
    if (match && alive.some((row) => row.agent === match.role)) return match.role;
  }
  for (const member of members) {
    if (alive.some((row) => row.agent === member.role)) return member.role;
  }
  return alive[0]?.agent ?? members[0]?.role ?? "LEAD_REASONER";
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
