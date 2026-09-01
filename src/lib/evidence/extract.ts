import { hashContent } from "../history/hash.ts";
import { extractorFingerprint } from "./hash.ts";
import type { CacheStore, CachedExtraction, EvidenceChunk, LedgerEntry } from "./types.ts";

const MIN_CLAIM_CHARS = 24;
const SENTENCE_RE = /[^.!?\n]+[.!?]?/g;

export function citationFor(chunk: EvidenceChunk): string {
  if (chunk.sourceKind === "CHAT") {
    const seq = chunk.messageSeq ?? chunk.ordinal + 1;
    return `[CHAT:${chunk.sourceId}:${seq}]`;
  }
  const span = chunk.fileSpan ?? { start: 0, end: chunk.text.length };
  return `[FILE:${chunk.sourceId}:${span.start}-${span.end}]`;
}

export function parseCitation(citation: string): {
  sourceKind: "CHAT" | "FILE";
  sourceId: string;
  messageSeq: number | null;
  fileSpan: { start: number; end: number } | null;
} | null {
  const chat = citation.match(/^\[CHAT:([^:\]]+):(\d+)\]$/);
  if (chat) {
    return { sourceKind: "CHAT", sourceId: chat[1] ?? "", messageSeq: Number(chat[2]), fileSpan: null };
  }
  const file = citation.match(/^\[FILE:([^:\]]+):(\d+)-(\d+)\]$/);
  if (file) {
    return {
      sourceKind: "FILE",
      sourceId: file[1] ?? "",
      messageSeq: null,
      fileSpan: { start: Number(file[2]), end: Number(file[3]) },
    };
  }
  return null;
}

function sentences(text: string): string[] {
  const found = text.match(SENTENCE_RE) ?? [];
  return found.map((row) => row.trim()).filter((row) => row.length >= MIN_CLAIM_CHARS);
}

export function extractChunk(chunk: EvidenceChunk): LedgerEntry[] {
  const fingerprint = extractorFingerprint();
  const claims = sentences(chunk.text);
  const used = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const claim of claims) {
    const key = hashContent(claim.toLowerCase());
    if (used.has(key)) continue;
    used.add(key);
    entries.push({
      id: hashContent(`${chunk.id}:${key}`).replace(":", ""),
      chunkId: chunk.id,
      projectId: chunk.projectId,
      sourceKind: chunk.sourceKind,
      sourceId: chunk.sourceId,
      claim,
      status: "HISTORICALLY_ASSERTED",
      citation: citationFor(chunk),
      extractorFingerprint: fingerprint,
      kind: "EVIDENCE",
    });
  }
  return entries;
}

export function chunkEvidenceStats(chunks: EvidenceChunk[], entries: LedgerEntry[]): {
  chunksWithEvidence: number;
  chunksWithoutEvidence: number;
} {
  const withEvidence = new Set(entries.map((row) => row.chunkId));
  const chunksWithEvidence = chunks.filter((row) => withEvidence.has(row.id)).length;
  return {
    chunksWithEvidence,
    chunksWithoutEvidence: chunks.length - chunksWithEvidence,
  };
}

export function extractChunks(
  chunks: EvidenceChunk[],
  cache?: CacheStore,
  fingerprint?: string,
): {
  entries: LedgerEntry[];
  cacheHits: number;
  processed: number;
  chunksWithEvidence: number;
  chunksWithoutEvidence: number;
} {
  if (fingerprint && cache) {
    const hit = cache.get(fingerprint);
    if (hit) {
      const stats = chunkEvidenceStats(hit.chunks, hit.entries);
      return {
        entries: hit.entries,
        cacheHits: hit.chunks.length,
        processed: hit.chunks.length,
        ...stats,
      };
    }
  }
  const entries = chunks.flatMap(extractChunk);
  if (fingerprint && cache) {
    cache.set(fingerprint, { fingerprint, chunks, entries });
  }
  return {
    entries,
    cacheHits: 0,
    processed: chunks.length,
    ...chunkEvidenceStats(chunks, entries),
  };
}

export function memoryCache(): CacheStore {
  const map = new Map<string, CachedExtraction>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}
