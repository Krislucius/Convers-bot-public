import type { CoverageStatus, EvidenceManifest } from "./types.ts";

export const PACKED_CITATION_PREVIEW = 5;

export function visiblePackedCitations<T>(rows: T[], showAll: boolean): T[] {
  if (showAll) return rows;
  return rows.slice(0, PACKED_CITATION_PREVIEW);
}

export function ledgerFoldLabel(input: {
  status: CoverageStatus | string;
  sources: number;
  chunks: number;
  claims: number;
  packed: number;
}): string {
  return `${input.status} | ${input.sources} sources | ${input.chunks} chunks | ${input.claims} claims | ${input.packed} packed`;
}

export function ledgerFoldLabelFromManifest(
  manifest: Pick<EvidenceManifest, "coverageStatus" | "sources" | "audit" | "evidenceCount">,
): string {
  return ledgerFoldLabel({
    status: manifest.coverageStatus,
    sources: manifest.sources.length,
    chunks: manifest.audit.chunksProcessed,
    claims: manifest.evidenceCount,
    packed: manifest.audit.packedEvidence,
  });
}

export function truncateClaim(text: string, max = 160): string {
  const value = text.trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
