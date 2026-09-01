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

export function synthesizerAgent(rows: AgentResponse[]): AgentKey {
  return survivingResponses(rows)[0]?.agent ?? "GPT";
}
