import type { Artifact, ArtifactStatus, ArtifactType, EvidenceLabel, EvidenceStatus } from "./types.ts";

const TYPES: ArtifactType[] = [
  "SPECIFICATION",
  "ARCHITECTURE",
  "PLAN",
  "ADR",
  "PROJECT_STATE",
  "OTHER",
];

const EVIDENCE: EvidenceStatus[] = [
  "EVIDENCED",
  "INFERRED",
  "UNKNOWN",
  "CONFLICTED",
  "HISTORICALLY_ASSERTED",
  "HISTORICALLY_FROZEN",
];

export function asArtifactType(value: unknown): ArtifactType {
  const text = String(value ?? "").toUpperCase();
  return TYPES.includes(text as ArtifactType) ? (text as ArtifactType) : "SPECIFICATION";
}

export function asEvidenceStatus(value: unknown): EvidenceStatus {
  const text = String(value ?? "").toUpperCase();
  return EVIDENCE.includes(text as EvidenceStatus) ? (text as EvidenceStatus) : "UNKNOWN";
}

export function parseEvidenceLabels(value: unknown): EvidenceLabel[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const rec = row as Record<string, unknown>;
      const claim = String(rec.claim ?? rec.text ?? "").trim();
      if (!claim) return null;
      return {
        claim,
        status: asEvidenceStatus(rec.status ?? rec.provenance),
        citation: rec.citation == null || rec.citation === "" ? null : String(rec.citation),
      } satisfies EvidenceLabel;
    })
    .filter((row): row is EvidenceLabel => Boolean(row));
}

export function parseSynthesizedArtifact(value: unknown): {
  type: ArtifactType;
  title: string;
  version: string;
  content: string;
  evidenceLabels: EvidenceLabel[];
} | null {
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const content = String(rec.content ?? rec.body ?? rec.markdown ?? "").trim();
  const title = String(rec.title ?? "").trim();
  if (!content || !title) return null;
  return {
    type: asArtifactType(rec.type),
    title,
    version: String(rec.version ?? "1.0").trim() || "1.0",
    content,
    evidenceLabels: parseEvidenceLabels(rec.evidenceLabels ?? rec.evidence_labels ?? rec.provenance),
  };
}

export function normalizeEvidenceLabels(labels: EvidenceLabel[], repositoryPresent = false): EvidenceLabel[] {
  return labels.map((label) => {
    let status = label.status;
    const citation = label.citation;
    if (status === "HISTORICALLY_FROZEN" && !citation) status = "HISTORICALLY_ASSERTED";
    if (/implement/i.test(label.claim) && !repositoryPresent) {
      if (status === "EVIDENCED" || !["UNKNOWN", "HISTORICALLY_ASSERTED", "INFERRED", "CONFLICTED"].includes(status)) {
        status = "UNKNOWN";
      }
    }
    return { ...label, status, citation };
  });
}

export function implementationClaimsAreUnknown(labels: EvidenceLabel[]): boolean {
  return labels
    .filter((row) => /implement/i.test(row.claim))
    .every((row) => row.status === "UNKNOWN" || row.status === "HISTORICALLY_ASSERTED" || row.status === "INFERRED");
}

export function historyDidNotMintFrozen(labels: EvidenceLabel[]): boolean {
  return labels.every((row) => {
    if (row.status === "HISTORICALLY_FROZEN") return Boolean(row.citation);
    return true;
  });
}

export function reviewMustNotReplace(created: Artifact | null): boolean {
  return created == null;
}

export function nextArtifactStatus(councilStatus: string | null): ArtifactStatus {
  if (councilStatus === "BLOCKED") return "BLOCKED";
  if (councilStatus === "USER_DECISION_REQUIRED") return "DRAFT";
  return "READY_FOR_REVIEW";
}
