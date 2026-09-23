import { hashContent } from "../history/hash.ts";
import type { ProjectFile, Task } from "../council/types.ts";
import { classifyFileSource, type FileSourceState } from "./source-state.ts";

export type CommonEvidencePacket = {
  evidenceSnapshotId: string;
  packedEvidenceHash: string;
  taskCanonical: string;
  chatCount: number;
  fileCount: number;
  coverageStatus: string;
  sourceStates: FileSourceState[];
  packedCitations: string[];
  memberContext: string;
  parity: "PASS" | "FAIL";
};

export function evidenceParity(memberContexts: string[]): "PASS" | "FAIL" {
  if (!memberContexts.length) return "FAIL";
  const first = memberContexts[0];
  return memberContexts.every((row) => row === first) ? "PASS" : "FAIL";
}

function availabilityBlock(packet: {
  evidenceSnapshotId: string;
  packedEvidenceHash: string;
  parity: "PASS" | "FAIL";
  chatCount: number;
  fileCount: number;
  coverageStatus: string;
  sourceStates: FileSourceState[];
}): string {
  const files = packet.sourceStates
    .map(
      (row) =>
        `FILE ${row.filename} id=${row.fileId} SOURCE_STATUS=${row.sourceStatus} language=${row.language} pages=${row.pages ?? "unknown"} chunks=${row.chunks} characters=${row.characters} extraction_method=${row.extractionMethod} source_hash=${row.sourceHash}`,
    )
    .join("\n");
  return [
    "## SOURCE AVAILABILITY",
    "System state. Every Council member receives this exact snapshot. Do not invent a different source status.",
    `evidence_snapshot_id: ${packet.evidenceSnapshotId}`,
    `packed_evidence_hash: ${packet.packedEvidenceHash}`,
    `COMMON_EVIDENCE_PARITY: ${packet.parity}`,
    `CHATS: ${packet.chatCount}`,
    `FILES: ${packet.fileCount}`,
    `COVERAGE: ${packet.coverageStatus}`,
    files || "FILES: none",
    "If SOURCE_STATUS=EXTRACTED, the extracted text is in the evidence above. Do not claim the file is unreadable, that PDF text is unavailable, or that you cannot inspect the attachment.",
  ].join("\n");
}

export function buildCommonEvidencePacket(input: {
  task: Pick<Task, "canonicalTaskEn" | "prompt" | "title">;
  packText: string;
  chatCount: number;
  files: Array<
    Pick<ProjectFile, "id" | "filename" | "kind" | "extractedText" | "notes" | "characterCount"> &
      Partial<Pick<ProjectFile, "sourceStatus" | "sourceLanguage" | "pageCount" | "chunkCount" | "extractionMethod" | "sourceHash">>
  >;
  chunkCountByFile?: Record<string, number>;
  coverageStatus: string;
  packedCitations: string[];
}): CommonEvidencePacket {
  const sourceStates = input.files
    .map((file) => classifyFileSource(file, input.chunkCountByFile?.[file.id]))
    .sort((a, b) => a.fileId.localeCompare(b.fileId));
  const taskCanonical = (input.task.canonicalTaskEn || input.task.prompt || "").trim();
  const identity = {
    taskCanonical,
    title: input.task.title,
    chatCount: input.chatCount,
    coverageStatus: input.coverageStatus,
    packedCitations: [...input.packedCitations].sort(),
    sourceStates,
    packText: input.packText,
  };
  const packedEvidenceHash = hashContent(JSON.stringify(identity));
  const evidenceSnapshotId = `ev_${packedEvidenceHash.slice(0, 24)}`;
  const parity = evidenceParity([input.packText, input.packText]);
  const memberContext = `${input.packText}\n\n${availabilityBlock({
    evidenceSnapshotId,
    packedEvidenceHash,
    parity,
    chatCount: input.chatCount,
    fileCount: sourceStates.length,
    coverageStatus: input.coverageStatus,
    sourceStates,
  })}`;
  const confirmed = evidenceParity([memberContext, memberContext]);
  return {
    evidenceSnapshotId,
    packedEvidenceHash,
    taskCanonical,
    chatCount: input.chatCount,
    fileCount: sourceStates.length,
    coverageStatus: input.coverageStatus,
    sourceStates,
    packedCitations: input.packedCitations,
    memberContext,
    parity: confirmed,
  };
}

/** Same snapshot id and the same source availability for every member view. */
export function assertCommonEvidenceParity(packets: CommonEvidencePacket[]): "PASS" | "FAIL" {
  if (!packets.length) return "FAIL";
  const contexts = packets.map((row) => row.memberContext);
  if (evidenceParity(contexts) !== "PASS") return "FAIL";
  const ids = new Set(packets.map((row) => row.evidenceSnapshotId));
  if (ids.size !== 1) return "FAIL";
  const availability = packets.map((row) =>
    row.sourceStates.map((state) => `${state.fileId}:${state.sourceStatus}:${state.sourceHash}`).join("|"),
  );
  return evidenceParity(availability) === "PASS" && packets.every((row) => row.parity === "PASS") ? "PASS" : "FAIL";
}
