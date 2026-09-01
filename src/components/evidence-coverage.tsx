import { useState } from "react";
import { GhostButton, StatusPill } from "@/components/council-ui";
import { parseCitation } from "@/lib/evidence/extract";
import {
  PACKED_CITATION_PREVIEW,
  ledgerFoldLabelFromManifest,
  truncateClaim,
  visiblePackedCitations,
} from "@/lib/evidence/preview";
import type { EvidenceChunk, EvidenceManifest, LedgerEntry } from "@/lib/evidence/types";
import { COVERAGE_COMPLETE_MEANING } from "@/lib/evidence/types";

export function EvidenceCoveragePanel({
  manifest,
  packed,
  chunks,
  compact = false,
}: {
  manifest: EvidenceManifest;
  packed: LedgerEntry[];
  chunks: EvidenceChunk[];
  compact?: boolean;
}) {
  const [openCitation, setOpenCitation] = useState<string | null>(null);
  const [showAllPacked, setShowAllPacked] = useState(false);
  const reimport = manifest.sources.filter((row) => row.status === "REIMPORT_REQUIRED");
  const audit = manifest.audit;
  const visible = visiblePackedCitations(packed, showAllPacked);
  const header = ledgerFoldLabelFromManifest(manifest);

  return (
    <div>
      {compact ? null : (
        <>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Evidence ledger</p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusPill status={manifest.coverageStatus} />
            <p className="m-0 min-w-0 text-sm break-words text-faint">{header}</p>
          </div>
          <dl className="m-0 mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Coverage" value={manifest.coverageStatus} />
            <Stat label="Chunks processed" value={String(audit.chunksProcessed)} />
            <Stat label="Evidence claims" value={String(audit.evidenceCount)} />
            <Stat label="Packed evidence" value={String(audit.packedEvidence)} />
          </dl>
        </>
      )}
      <p className="mt-0 mb-0 text-sm text-muted">{manifest.coverageMeaning || COVERAGE_COMPLETE_MEANING}</p>
      {reimport.length > 0 ? (
        <p className="mt-3 mb-0 text-sm text-danger">
          Re-import required for {reimport.map((row) => row.sourceId).join(", ")}. Previously truncated text cannot be
          recovered.
        </p>
      ) : null}
      <h3 className="mt-4 mb-2 text-sm font-semibold tracking-widest text-muted uppercase">Source coverage</h3>
      <ul className="mt-0 mb-0 grid max-h-log list-none gap-2 overflow-auto p-0">
        {manifest.sources.length === 0 ? (
          <li className="text-sm text-muted">No selected chats or files.</li>
        ) : (
          manifest.sources.map((row) => (
            <li key={`${row.sourceKind}:${row.sourceId}`} className="rounded-md bg-bg px-3 py-3 text-sm">
              <StatusPill status={row.status} />{" "}
              <span className="font-medium break-words text-fg">
                {row.sourceKind} {row.sourceId}
              </span>
              <span className="mt-1 block font-mono text-xs break-all text-faint">
                {row.processedChunks}/{row.chunkCount} processed · {row.chunksWithEvidence} with evidence ·{" "}
                {row.chunksWithoutEvidence} without · {row.evidenceCount} claims
                {row.cacheHits ? ` · cache ${row.cacheHits}` : ""}
                {row.omittedReason ? ` · ${row.omittedReason}` : ""}
              </span>
            </li>
          ))
        )}
      </ul>
      <h3 className="mt-4 mb-2 text-sm font-semibold tracking-widest text-muted uppercase">Packed citations</h3>
      <ul className="mt-0 mb-0 grid max-h-log list-none gap-2 overflow-auto p-0">
        {visible.length === 0 ? (
          <li className="text-sm text-muted">No packed citations.</li>
        ) : (
          visible.map((row) => {
            const parsed = parseCitation(row.citation);
            const chunk = chunks.find((item) => item.id === row.chunkId);
            const active = openCitation === row.id;
            return (
              <li key={row.id} className="rounded-md bg-bg px-3 py-3 text-sm">
                <button
                  type="button"
                  className="m-0 min-h-11 w-full min-w-0 border-0 bg-transparent p-0 text-left text-fg"
                  onClick={() => setOpenCitation(active ? null : row.id)}
                >
                  <StatusPill status={row.status} /> {truncateClaim(row.claim)}{" "}
                  <span className="block font-mono text-xs break-all text-faint">{row.citation}</span>
                </button>
                {active ? (
                  <p className="mt-2 mb-0 max-h-log overflow-auto font-mono text-xs break-words text-muted">
                    {row.claim}
                    {chunk ? (
                      <>
                        <br />
                        {parsed?.sourceKind} {chunk.sourceId}
                        {chunk.messageSeq != null ? ` · message ${chunk.messageSeq}` : ""}
                        {chunk.fileSpan ? ` · chars ${chunk.fileSpan.start}–${chunk.fileSpan.end}` : ""}
                        <br />
                        {chunk.text}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </li>
            );
          })
        )}
      </ul>
      {packed.length > PACKED_CITATION_PREVIEW ? (
        <GhostButton type="button" className="mt-3" onClick={() => setShowAllPacked((value) => !value)}>
          {showAllPacked ? "Show first 5" : `Show all (${packed.length})`}
        </GhostButton>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-subtle p-3">
      <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
      <dd className="font-display m-0 text-lg tabular-nums">{value}</dd>
    </div>
  );
}
