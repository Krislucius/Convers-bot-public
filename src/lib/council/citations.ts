import { parseCitation } from "../evidence/extract.ts";
import type { EvidenceLabel } from "./types.ts";

export function isPackedCitation(citation: string | null | undefined, packed: string[]): boolean {
  if (!citation) return false;
  return packed.includes(citation);
}

export function sanitizeEvidenceLabels(
  labels: EvidenceLabel[],
  packedCitations: string[],
): { labels: EvidenceLabel[]; invalid: string[] } {
  const packed = new Set(packedCitations);
  const invalid: string[] = [];
  const next = labels.map((label) => {
    const citation = label.citation;
    if (!citation) {
      if (label.status === "HISTORICALLY_FROZEN" || label.status === "EVIDENCED") {
        invalid.push(label.claim);
        return { ...label, status: "UNKNOWN" as const };
      }
      return label;
    }
    const parsed = parseCitation(citation);
    if (!parsed || !packed.has(citation)) {
      invalid.push(citation);
      const status: EvidenceLabel["status"] =
        label.status === "HISTORICALLY_FROZEN" ? "HISTORICALLY_ASSERTED" : "UNKNOWN";
      return { ...label, status };
    }
    return label;
  });
  return { labels: next, invalid };
}
