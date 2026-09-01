import { hashContent } from "../history/hash.ts";
import { messagesForSource, resolveChatsForRun } from "../history/provenance.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import type { ProjectFile } from "../council/types.ts";
import { CHUNKER_VERSION, type EvidenceChunk, type SourceKind } from "./types.ts";

export const TARGET_CHUNK_CHARS = 4000;

function splitText(text: string): string[] {
  if (!text) return [];
  if (text.length <= TARGET_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  const blocks = text.split(/\n{2,}/);
  let buf = "";
  const flush = () => {
    if (buf) parts.push(buf);
    buf = "";
  };
  for (const block of blocks) {
    if ((buf ? buf.length + 2 : 0) + block.length <= TARGET_CHUNK_CHARS) {
      buf = buf ? `${buf}\n\n${block}` : block;
      continue;
    }
    flush();
    if (block.length <= TARGET_CHUNK_CHARS) {
      buf = block;
      continue;
    }
    let start = 0;
    while (start < block.length) {
      parts.push(block.slice(start, start + TARGET_CHUNK_CHARS));
      start += TARGET_CHUNK_CHARS;
    }
  }
  flush();
  return parts.length ? parts : [text];
}

function chunkId(sourceKind: SourceKind, sourceId: string, ordinal: number, contentHash: string): string {
  return hashContent(`${sourceKind}:${sourceId}:${ordinal}:${contentHash}`).replace(":", "");
}

export function chunkChatSource(
  projectId: string,
  source: ChatSource,
  messages: HistoryMessage[],
): EvidenceChunk[] {
  const turns = messagesForSource(messages, source.id);
  const units =
    turns.length > 0
      ? turns.map((turn) => ({ seq: turn.sequence, text: `${turn.role}: ${turn.content}` }))
      : [{ seq: null as number | null, text: source.rawContent }];
  const chunks: EvidenceChunk[] = [];
  let ordinal = 0;
  for (const unit of units) {
    const pieces = splitText(unit.text);
    for (const piece of pieces) {
      const contentHash = hashContent(piece);
      chunks.push({
        id: chunkId("CHAT", source.id, ordinal, contentHash),
        projectId,
        sourceKind: "CHAT",
        sourceId: source.id,
        messageSeq: unit.seq,
        fileSpan: null,
        ordinal,
        text: piece,
        contentHash,
        chunkerVersion: CHUNKER_VERSION,
      });
      ordinal += 1;
    }
  }
  return chunks;
}

export function chunkFile(projectId: string, file: ProjectFile): EvidenceChunk[] {
  const pieces = splitText(file.extractedText ?? "");
  const chunks: EvidenceChunk[] = [];
  let start = 0;
  pieces.forEach((piece, ordinal) => {
    const end = start + piece.length;
    const contentHash = hashContent(piece);
    chunks.push({
      id: chunkId("FILE", file.id, ordinal, contentHash),
      projectId,
      sourceKind: "FILE",
      sourceId: file.id,
      messageSeq: null,
      fileSpan: { start, end },
      ordinal,
      text: piece,
      contentHash,
      chunkerVersion: CHUNKER_VERSION,
    });
    start = end;
  });
  return chunks;
}

export function chunkSelectedSources(input: {
  projectId: string;
  selectedChatIds: string[];
  selectedFileIds: string[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  projectFiles: ProjectFile[];
}): EvidenceChunk[] {
  const chats = resolveChatsForRun(input.projectId, input.selectedChatIds, input.chatSources);
  const files = input.projectFiles.filter(
    (file) => file.projectId === input.projectId && input.selectedFileIds.includes(file.id),
  );
  return [
    ...chats.flatMap((source) => chunkChatSource(input.projectId, source, input.historyMessages)),
    ...files.flatMap((file) => chunkFile(input.projectId, file)),
  ];
}
