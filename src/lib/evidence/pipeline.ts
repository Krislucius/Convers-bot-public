import type { ContextItem, Project, ProjectFile, Task } from "../council/types.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import { hashContent } from "../history/hash.ts";
import { resolveChatsForRun } from "../history/provenance.ts";
import { chunkSelectedSources } from "./chunk.ts";
import { extractChunks, memoryCache } from "./extract.ts";
import { cacheFingerprint, extractorFingerprint } from "./hash.ts";
import { packEvidence } from "./pack.ts";
import { CHUNKER_VERSION, PACKER_VERSION } from "./types.ts";
import type {
  CacheStore,
  CoverageReport,
  CoverageStatus,
  EvidenceChunk,
  EvidenceManifest,
  LedgerEntry,
  PackResult,
  SourceCoverage,
  SourceKind,
} from "./types.ts";

const TRUNCATION_MARK = "[truncated]";

export const CONTEXT_BUDGET_EXCEEDED = "CONTEXT_BUDGET_EXCEEDED";
export const COVERAGE_INCOMPLETE = "COVERAGE_INCOMPLETE";

export function isTruncatedMarker(text: string | null | undefined): boolean {
  return Boolean(text && text.includes(TRUNCATION_MARK));
}

export function sourceNeedsReimport(input: {
  kind: SourceKind;
  rawContent?: string;
  extractedText?: string;
  notes?: string;
  messages: number;
}): boolean {
  if (input.kind === "CHAT") {
    const raw = input.rawContent ?? "";
    if (isTruncatedMarker(raw)) return true;
    if (!raw.trim() && input.messages === 0) return true;
    return false;
  }
  const text = input.extractedText ?? "";
  return isTruncatedMarker(text) || isTruncatedMarker(input.notes);
}

export function assertEvidenceNonCanonical(entries: LedgerEntry[]): boolean {
  return entries.every((row) => row.kind === "EVIDENCE");
}

function coverageStatus(sources: SourceCoverage[]): CoverageStatus {
  if (sources.some((row) => row.status === "REIMPORT_REQUIRED")) return "REIMPORT_REQUIRED";
  if (sources.some((row) => row.status === "FAILED")) return "FAILED";
  if (sources.some((row) => row.status === "PARTIAL")) return "PARTIAL";
  return "COMPLETE";
}

export function runEvidencePipeline(input: {
  project: Pick<Project, "id" | "name" | "description">;
  task: Task;
  frozen: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  projectFiles: ProjectFile[];
  candidateText?: string | null;
  cache?: CacheStore;
  failSourceIds?: string[];
}): {
  chunks: EvidenceChunk[];
  entries: LedgerEntry[];
  coverage: CoverageReport;
  pack: PackResult;
  manifest: EvidenceManifest;
} {
  const cache = input.cache ?? memoryCache();
  const chats = resolveChatsForRun(input.project.id, input.task.selectedChatSourceIds, input.chatSources);
  const files = input.projectFiles.filter(
    (file) => file.projectId === input.project.id && (input.task.selectedFileIds ?? []).includes(file.id),
  );

  const sources: SourceCoverage[] = [];
  const chunks: EvidenceChunk[] = [];
  const entries: LedgerEntry[] = [];
  let cacheHits = 0;

  const selected = [
    ...chats.map((source) => ({ kind: "CHAT" as const, id: source.id, hash: source.contentHash, source })),
    ...files.map((file) => ({
      kind: "FILE" as const,
      id: file.id,
      hash: hashContent(file.extractedText),
      file,
    })),
  ];

  for (const selectedSource of selected) {
    const fail = input.failSourceIds?.includes(selectedSource.id);
    if (selectedSource.kind === "CHAT") {
      const source = selectedSource.source;
      const messageCount = input.historyMessages.filter((row) => row.chatSourceId === source.id).length;
      if (
        sourceNeedsReimport({
          kind: "CHAT",
          rawContent: source.rawContent,
          messages: messageCount,
        })
      ) {
        sources.push({
          sourceId: source.id,
          sourceKind: "CHAT",
          sourceHash: source.contentHash,
          status: "REIMPORT_REQUIRED",
          chunkCount: 0,
          processedChunks: 0,
          evidenceCount: 0,
          cacheHits: 0,
          omittedReason: "REIMPORT_REQUIRED",
        });
        continue;
      }
    } else {
      const file = selectedSource.file;
      if (sourceNeedsReimport({ kind: "FILE", extractedText: file.extractedText, notes: file.notes, messages: 0 })) {
        sources.push({
          sourceId: file.id,
          sourceKind: "FILE",
          sourceHash: selectedSource.hash,
          status: "REIMPORT_REQUIRED",
          chunkCount: 0,
          processedChunks: 0,
          evidenceCount: 0,
          cacheHits: 0,
          omittedReason: "REIMPORT_REQUIRED",
        });
        continue;
      }
    }

    const fingerprint = cacheFingerprint(selectedSource.hash);
    try {
      if (fail) throw new Error("extractor failed");
      const sourceChunks = chunkSelectedSources({
        projectId: input.project.id,
        selectedChatIds: selectedSource.kind === "CHAT" ? [selectedSource.id] : [],
        selectedFileIds: selectedSource.kind === "FILE" ? [selectedSource.id] : [],
        chatSources: input.chatSources,
        historyMessages: input.historyMessages,
        projectFiles: input.projectFiles,
      });
      const extracted = extractChunks(sourceChunks, cache, fingerprint);
      chunks.push(...sourceChunks);
      entries.push(...extracted.entries);
      const hit = extracted.cacheHits > 0;
      cacheHits += extracted.cacheHits > 0 ? 1 : 0;
      sources.push({
        sourceId: selectedSource.id,
        sourceKind: selectedSource.kind,
        sourceHash: selectedSource.hash,
        status: hit ? "CACHE_HIT" : "COMPLETE",
        chunkCount: sourceChunks.length,
        processedChunks: hit ? 0 : extracted.processed,
        evidenceCount: extracted.entries.length,
        cacheHits: hit ? 1 : 0,
        omittedReason: null,
      });
    } catch {
      sources.push({
        sourceId: selectedSource.id,
        sourceKind: selectedSource.kind,
        sourceHash: selectedSource.hash,
        status: "FAILED",
        chunkCount: 0,
        processedChunks: 0,
        evidenceCount: 0,
        cacheHits: 0,
        omittedReason: "FAILED",
      });
    }
  }

  const coverage: CoverageReport = {
    status: coverageStatus(sources),
    sources,
    chunkCount: chunks.length,
    evidenceCount: entries.length,
    cacheHits,
    extractorFingerprint: extractorFingerprint(),
    chunkerVersion: CHUNKER_VERSION,
  };

  if (!assertEvidenceNonCanonical(entries)) {
    throw new Error("Ledger evidence must stay non-canonical.");
  }

  const pack = packEvidence({
    project: input.project,
    task: input.task,
    frozen: input.frozen.filter((row) => row.kind !== "RAW_HISTORY"),
    entries,
    candidateText: input.candidateText,
  });

  const ledgerHash = hashContent(entries.map((row) => `${row.citation}:${row.claim}`).sort().join("\n"));
  const contextHash = hashContent(pack.text);
  const manifest: EvidenceManifest = {
    extractorFingerprint: extractorFingerprint(),
    chunkerVersion: CHUNKER_VERSION,
    packerVersion: PACKER_VERSION,
    coverageStatus: coverage.status,
    ledgerHash,
    contextHash,
    selectedSourceHashes: selected.map((row) => ({
      sourceId: row.id,
      sourceKind: row.kind,
      hash: row.hash,
    })),
    sources,
    packedCitations: pack.packed.map((row) => row.citation),
    omitted: pack.omitted,
    evidenceCount: entries.length,
    chunkCount: chunks.length,
    cacheHits,
    processedChunks: sources.reduce((sum, row) => sum + row.processedChunks, 0),
  };

  return { chunks, entries, coverage, pack, manifest };
}

export function coverageBlocksCouncil(coverage: CoverageReport): string | null {
  if (coverage.status === "COMPLETE") return null;
  if (coverage.status === "REIMPORT_REQUIRED") {
    return "One or more selected sources were previously truncated and must be re-imported before Council can run.";
  }
  if (coverage.status === "FAILED") {
    return "Evidence extraction failed for one or more selected sources. Coverage is not complete.";
  }
  return "Evidence coverage is partial. Council will not run until every selected source is processed.";
}
