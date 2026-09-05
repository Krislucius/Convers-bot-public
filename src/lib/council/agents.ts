import type { CouncilMember } from "./members.ts";
import type { AgentKey, AgentResponse } from "./types.ts";

export const MIN_SURVIVING_AGENTS = 2;

export function survivingResponses(rows: AgentResponse[]): AgentResponse[] {
  return rows.filter((row) => !row.error);
}

export function failedResponses(rows: AgentResponse[]): AgentResponse[] {
  return rows.filter((row) => Boolean(row.error));
}

export function councilAgentFailure(rows: AgentResponse[]): string | null {
  const ok = survivingResponses(rows);
  if (ok.length >= MIN_SURVIVING_AGENTS) return null;
  return failedResponses(rows)[0]?.error ?? "A reviewer failed.";
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
