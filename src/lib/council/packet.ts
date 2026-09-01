import { hashContent } from "../history/hash.ts";
import { nid } from "./protocol.ts";
import type {
  Artifact,
  ContextItem,
  CouncilResult,
  ImplementationPacket,
  ImplementationStatus,
  PacketStatus,
  ReviewVerdict,
  Task,
} from "./types.ts";

export const PACKET_READY: PacketStatus = "READY";
export const PACKET_HANDED_OFF: PacketStatus = "HANDED_OFF";
export const PACKET_RESULT_RECORDED: PacketStatus = "RESULT_RECORDED";
export const PACKET_REVIEW_OPEN: PacketStatus = "REVIEW_OPEN";
export const PACKET_CLOSED: PacketStatus = "CLOSED";

function linesFrom(text: string): string[] {
  return text
    .split(/\n+/)
    .map((row) => row.replace(/^[-*#\d.)\s]+/, "").trim())
    .filter((row) => row.length >= 8);
}

export function packetHash(packet: Omit<ImplementationPacket, "id" | "createdAt" | "packetHash">): string {
  return hashContent(
    JSON.stringify({
      scope: packet.scope,
      requirements: packet.requirements,
      invariants: packet.invariants,
      evidenceRefs: packet.evidenceRefs,
      acceptanceTests: packet.acceptanceTests,
      blockers: packet.blockers,
      iteration: packet.iteration,
    }),
  );
}

export function buildImplementationPacket(input: {
  project: { id: string; name: string };
  task: Pick<Task, "id" | "title" | "prompt" | "decisionQuestion">;
  artifact: Artifact;
  result: Pick<CouncilResult, "blockers" | "status">;
  frozen: ContextItem[];
  packedCitations: string[];
  parentPacketId?: string | null;
  iteration?: number;
  now?: string;
}): ImplementationPacket {
  const requirements = [
    ...input.artifact.evidenceLabels.map((row) => row.claim),
    ...linesFrom(input.artifact.content).slice(0, 12),
  ]
    .map((row) => row.trim())
    .filter((row, index, all) => row && all.indexOf(row) === index)
    .slice(0, 16);
  const invariants = input.frozen
    .filter((row) => row.kind === "INVARIANT" && row.status === "FROZEN" && row.projectId === input.project.id)
    .map((row) => row.content);
  const evidenceRefs = [...new Set(input.packedCitations)];
  const acceptanceTests = (requirements.length ? requirements : [input.task.prompt]).map(
    (row) => `Verify: ${row.slice(0, 180)}`,
  );
  const scope = `${input.project.name}: implement ${input.artifact.title} v${input.artifact.version} from ${input.task.title}. ${input.task.decisionQuestion ?? input.task.prompt}`.trim();
  const base = {
    projectId: input.project.id,
    taskId: input.task.id,
    artifactId: input.artifact.id,
    parentPacketId: input.parentPacketId ?? null,
    iteration: input.iteration ?? 1,
    status: PACKET_READY as PacketStatus,
    scope,
    requirements,
    invariants,
    evidenceRefs,
    acceptanceTests,
    blockers: [...input.result.blockers],
    handoffAt: null,
    implementationStatus: null,
    implementationNotes: null,
    implementationRecordedAt: null,
    reviewTaskId: null,
  };
  return {
    id: nid(),
    ...base,
    packetHash: packetHash(base),
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function handOffPacket(packet: ImplementationPacket, now = new Date().toISOString()): ImplementationPacket {
  return { ...packet, status: PACKET_HANDED_OFF, handoffAt: now };
}

export function recordImplementation(
  packet: ImplementationPacket,
  input: { status: ImplementationStatus; notes: string; now?: string },
): ImplementationPacket {
  const now = input.now ?? new Date().toISOString();
  return {
    ...packet,
    status: PACKET_RESULT_RECORDED,
    implementationStatus: input.status,
    implementationNotes: input.notes,
    implementationRecordedAt: now,
  };
}

export function openPacketReview(packet: ImplementationPacket, reviewTaskId: string): ImplementationPacket {
  return { ...packet, status: PACKET_REVIEW_OPEN, reviewTaskId };
}

export function applyPacketReview(packet: ImplementationPacket, verdict: ReviewVerdict): ImplementationPacket {
  if (verdict === "PASS") return { ...packet, status: PACKET_CLOSED };
  if (verdict === "BLOCKED") return { ...packet, status: PACKET_CLOSED };
  return { ...packet, status: PACKET_READY, reviewTaskId: null };
}

export function nextPatchIteration(packet: ImplementationPacket): number {
  return packet.iteration + 1;
}

export function packetForProject(packets: ImplementationPacket[], projectId: string): ImplementationPacket[] {
  return packets.filter((row) => row.projectId === projectId);
}

export function serializePacketHandoff(packet: ImplementationPacket): string {
  return JSON.stringify(
    {
      kind: "CONVERSATION_BOT_IMPLEMENTATION_PACKET",
      id: packet.id,
      hash: packet.packetHash,
      iteration: packet.iteration,
      scope: packet.scope,
      requirements: packet.requirements,
      invariants: packet.invariants,
      evidenceRefs: packet.evidenceRefs,
      acceptanceTests: packet.acceptanceTests,
      blockers: packet.blockers,
    },
    null,
    2,
  );
}
