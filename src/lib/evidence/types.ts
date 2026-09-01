export const CHUNKER_VERSION = "chunker-v1";
export const EXTRACTOR_VERSION = "extract-v1-heuristic";
export const EXTRACTOR_MODEL = "none";
export const EXTRACTOR_PROMPT_VERSION = "heuristic-sentences-v1";
export const PACKER_VERSION = "packer-v1";

export type SourceKind = "CHAT" | "FILE";

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "FAILED" | "REIMPORT_REQUIRED";

export type SourceCoverageStatus = CoverageStatus | "CACHE_HIT";

export type EvidenceChunk = {
  id: string;
  projectId: string;
  sourceKind: SourceKind;
  sourceId: string;
  messageSeq: number | null;
  fileSpan: { start: number; end: number } | null;
  ordinal: number;
  text: string;
  contentHash: string;
  chunkerVersion: string;
};

export type LedgerEntry = {
  id: string;
  chunkId: string;
  projectId: string;
  sourceKind: SourceKind;
  sourceId: string;
  claim: string;
  status: "HISTORICALLY_ASSERTED" | "EVIDENCED" | "INFERRED" | "UNKNOWN";
  citation: string;
  extractorFingerprint: string;
  kind: "EVIDENCE";
};

export type CachedExtraction = {
  fingerprint: string;
  chunks: EvidenceChunk[];
  entries: LedgerEntry[];
};

export type CacheStore = {
  get(fingerprint: string): CachedExtraction | undefined;
  set(fingerprint: string, value: CachedExtraction): void;
};

export type SourceCoverage = {
  sourceId: string;
  sourceKind: SourceKind;
  sourceHash: string;
  status: SourceCoverageStatus;
  chunkCount: number;
  processedChunks: number;
  evidenceCount: number;
  cacheHits: number;
  omittedReason: string | null;
};

export type CoverageReport = {
  status: CoverageStatus;
  sources: SourceCoverage[];
  chunkCount: number;
  evidenceCount: number;
  cacheHits: number;
  extractorFingerprint: string;
  chunkerVersion: string;
};

export type OmissionReason = "BUDGET" | "SOURCE_CAP" | "DUPLICATE";

export type PackOmission = {
  citation: string;
  claim: string;
  sourceId: string;
  reason: OmissionReason;
};

export type PackResult = {
  ok: boolean;
  code: "OK" | "CONTEXT_BUDGET_EXCEEDED";
  text: string;
  packed: LedgerEntry[];
  omitted: PackOmission[];
  mandatoryChars: number;
  evidenceChars: number;
};

export type EvidenceManifest = {
  extractorFingerprint: string;
  chunkerVersion: string;
  packerVersion: string;
  coverageStatus: CoverageStatus;
  ledgerHash: string;
  contextHash: string;
  selectedSourceHashes: Array<{ sourceId: string; sourceKind: SourceKind; hash: string }>;
  sources: SourceCoverage[];
  packedCitations: string[];
  omitted: PackOmission[];
  evidenceCount: number;
  chunkCount: number;
  cacheHits: number;
  processedChunks: number;
};
