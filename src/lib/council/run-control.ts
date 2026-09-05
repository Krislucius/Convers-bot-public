import type { CouncilMember } from "./members.ts";
import type { AgentKey, AgentProgress, AgentResponse, ProviderId, TaskStatus } from "./types.ts";
import type { RequestBudget } from "./request-budget.ts";

export const RUN_ID_FIELD = "__runId";
export const MAX_AUDITED_RUNS = 8;

export type CouncilStageName = "PREPARING" | "ROUND_1" | "ROUND_2" | "SYNTHESIS" | "COMPLETE" | "CANCELLED";

export type CouncilRunSnapshot = {
  runId: string;
  generation: number;
  stage: CouncilStageName;
  status: TaskStatus;
  startedAt: string;
  stageStartedAt: string;
  updatedAt: string;
  agents: Partial<Record<AgentKey, AgentProgress>>;
  message: string;
  provider?: ProviderId;
  members?: CouncilMember[];
  synthesizerModel?: string;
  requestBudget?: RequestBudget;
  costUsd?: number | null;
};

export class CouncilCancelled extends Error {
  readonly runId: string;
  constructor(runId: string, message = "Council run stopped.") {
    super(message);
    this.name = "CouncilCancelled";
    this.runId = runId;
  }
}

export type ActiveCouncilRun = {
  taskId: string;
  runId: string;
  generation: number;
  signal: AbortSignal;
  abort: () => void;
};

const byTask = new Map<string, { runId: string; generation: number; controller: AbortController }>();
let generationSeq = 0;

function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

export function beginCouncilRun(taskId: string): ActiveCouncilRun {
  const existing = byTask.get(taskId);
  if (existing) existing.controller.abort();
  generationSeq += 1;
  const generation = generationSeq;
  const runId = nid();
  const controller = new AbortController();
  byTask.set(taskId, { runId, generation, controller });
  return {
    taskId,
    runId,
    generation,
    signal: controller.signal,
    abort: () => {
      controller.abort();
    },
  };
}

export function stopCouncilRun(taskId: string, runId?: string): boolean {
  const row = byTask.get(taskId);
  if (!row) return false;
  if (runId && row.runId !== runId) return false;
  row.controller.abort();
  return true;
}

export function isCouncilRunCurrent(taskId: string, runId: string, generation: number): boolean {
  const row = byTask.get(taskId);
  return Boolean(row && row.runId === runId && row.generation === generation && !row.controller.signal.aborted);
}

export function activeCouncilRun(taskId: string): { runId: string; generation: number } | null {
  const row = byTask.get(taskId);
  if (!row || row.controller.signal.aborted) return null;
  return { runId: row.runId, generation: row.generation };
}

export function releaseCouncilRun(taskId: string, runId?: string): void {
  const row = byTask.get(taskId);
  if (!row) return;
  if (runId && row.runId !== runId) return;
  byTask.delete(taskId);
}

export function resetCouncilRuns(): void {
  byTask.clear();
  generationSeq = 0;
}

export function isCancelledSignal(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

export function throwIfCancelled(runId: string, signal?: AbortSignal): void {
  if (signal?.aborted) throw new CouncilCancelled(runId);
}

export function shouldAcceptRunWrite(currentRunId: string | null, incomingRunId: string | null): boolean {
  if (!currentRunId) return true;
  if (!incomingRunId) return true;
  return currentRunId === incomingRunId;
}

export function ownedResponses(rows: AgentResponse[], currentRunId: string | null, ownerRunId?: string | null): AgentResponse[] {
  const want = currentRunId ?? ownerRunId;
  if (!want) return rows;
  return rows.filter((row) => !row.runId || row.runId === want);
}

export function archiveRuns(
  previous: CouncilRunSnapshot[] | undefined,
  snap: CouncilRunSnapshot,
): CouncilRunSnapshot[] {
  const rest = (previous ?? []).filter((row) => row.runId !== snap.runId);
  return [snap, ...rest].slice(0, MAX_AUDITED_RUNS);
}
