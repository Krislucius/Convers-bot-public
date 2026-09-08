import { isSynthesisResponse } from "./agents.ts";
import { parseJson } from "./protocol.ts";
import type { AgentResponse, Artifact, CouncilResult, ImplementationPacket, RunCouncilOutput, TaskStatus } from "./types.ts";

export const EXCLUSIVE_TERMINALS = ["COMPLETE", "FAILED", "CANCELLED"] as const;
export type ExclusiveTerminal = (typeof EXCLUSIVE_TERMINALS)[number];

export function isExclusiveTerminal(status: string | null | undefined): status is ExclusiveTerminal {
  return status === "COMPLETE" || status === "FAILED" || status === "CANCELLED";
}

export function synthesisIsReconcilable(
  responses: AgentResponse[] | null | undefined,
  mode: string | null | undefined,
): boolean {
  const rows = (responses ?? []).filter((row) => isSynthesisResponse(row) && !row.error && row.responseText);
  const last = rows.at(-1);
  if (!last) return false;
  const parsed = parseJson(last.responseText);
  if (!parsed) return false;
  if (mode === "CREATE" && !parsed.artifact) return false;
  return true;
}

export function hasPersistedSynthesis(input: {
  status?: string | null;
  output?: RunCouncilOutput | null;
  responses?: AgentResponse[] | null;
  mode?: string | null;
  artifact?: Artifact | null;
}): boolean {
  if (input.output?.result) return true;
  if (input.output?.artifact) return true;
  if (input.artifact) return true;
  return synthesisIsReconcilable(input.responses ?? input.output?.responses, input.mode);
}

export function exclusiveRunState(input: {
  status?: string | null;
  snapshotStatus?: string | null;
  taskStatus?: TaskStatus | string | null;
  hasSynthesis?: boolean;
  hasArtifact?: boolean;
  result?: CouncilResult | null;
}): ExclusiveTerminal | null {
  const synthesisDone = Boolean(input.hasSynthesis || input.hasArtifact || input.result);
  if (synthesisDone) return "COMPLETE";
  const candidates = [input.status, input.snapshotStatus, input.taskStatus].filter(Boolean);
  if (candidates.includes("COMPLETE")) return "COMPLETE";
  if (candidates.includes("FAILED")) return "FAILED";
  if (candidates.includes("CANCELLED")) return "CANCELLED";
  return null;
}

export function canPersistArtifact(terminal: ExclusiveTerminal | string | null | undefined): boolean {
  return terminal === "COMPLETE";
}

export function canPersistPacket(
  terminal: ExclusiveTerminal | string | null | undefined,
  councilStatus: string | null | undefined,
): boolean {
  return terminal === "COMPLETE" && councilStatus === "APPROVED";
}

export function consistentFinalOutput(out: Pick<RunCouncilOutput, "task" | "result" | "artifact" | "packet">): {
  ok: boolean;
  terminal: ExclusiveTerminal | null;
  reason: string | null;
} {
  const terminal = exclusiveRunState({
    status: out.task.status,
    result: out.result,
    hasSynthesis: Boolean(out.result),
    hasArtifact: Boolean(out.artifact),
  });
  if (out.result && out.task.status !== "COMPLETE") {
    return { ok: false, terminal, reason: "synthesis result requires COMPLETE run state" };
  }
  if (out.artifact && out.task.status !== "COMPLETE") {
    return { ok: false, terminal, reason: "artifact requires COMPLETE synthesis state" };
  }
  if (out.packet && !canPersistPacket(terminal, out.result?.status ?? null)) {
    return { ok: false, terminal, reason: "packet requires COMPLETE + APPROVED" };
  }
  if (out.result) {
    const verdict = out.result.reconciledStatus ?? out.result.finalEnforcedStatus ?? out.result.status;
    if (verdict !== out.result.status) {
      return { ok: false, terminal, reason: "result.status must equal reconciledStatus" };
    }
    if (verdict === "BLOCKED" && out.result.blockers.length === 0) {
      return { ok: false, terminal, reason: "BLOCKED requires the final unresolved blocker set" };
    }
    if (verdict !== "BLOCKED" && out.result.blockers.length) {
      return { ok: false, terminal, reason: "non-BLOCKED result cannot keep blockers" };
    }
  }
  return { ok: true, terminal, reason: null };
}

export type DurableWriteDecision = "ACCEPT" | "REJECT" | "KEEP_CURRENT";

export function decideDurableWrite(input: {
  currentRunId: string;
  incomingRunId: string | null | undefined;
  currentGeneration: number;
  currentLeaseEpoch: number;
  expectedGeneration: number;
  expectedLeaseEpoch: number;
  currentStatus: string;
  incomingStatus: string;
  currentHasSynthesis: boolean;
  incomingHasSynthesis: boolean;
}): DurableWriteDecision {
  if (!input.incomingRunId || input.incomingRunId !== input.currentRunId) return "REJECT";
  const currentTerminal = exclusiveRunState({
    status: input.currentStatus,
    hasSynthesis: input.currentHasSynthesis,
  });
  if (currentTerminal === "COMPLETE" && input.incomingStatus !== "COMPLETE") return "KEEP_CURRENT";
  if (input.incomingStatus === "COMPLETE" && input.incomingHasSynthesis && currentTerminal !== "COMPLETE") {
    return "ACCEPT";
  }
  if (currentTerminal === "FAILED" && input.incomingStatus === "CANCELLED") return "KEEP_CURRENT";
  if (input.expectedGeneration !== input.currentGeneration) return "REJECT";
  if (input.expectedLeaseEpoch !== input.currentLeaseEpoch) return "REJECT";
  return "ACCEPT";
}

export function alignPacket(packet: ImplementationPacket | null, blockers: string[], status: string): ImplementationPacket | null {
  if (!packet) return null;
  if (status !== "APPROVED") return null;
  return { ...packet, blockers: [...blockers] };
}
