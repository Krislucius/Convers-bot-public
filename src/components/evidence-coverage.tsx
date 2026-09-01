import { useState } from "react";
import { Panel, StatusPill } from "@/components/council-ui";
import { parseCitation } from "@/lib/evidence/extract";
import type { EvidenceChunk, EvidenceManifest, LedgerEntry } from "@/lib/evidence/types";
import { COVERAGE_COMPLETE_MEANING } from "@/lib/evidence/types";

export function EvidenceCoveragePanel({
  manifest,
  packed,
  chunks,
}: {
  manifest: EvidenceManifest;
  packed: LedgerEntry[];
  chunks: EvidenceChunk[];
}) {
  const [open, setOpen] = useState<string | null>(null);
  const reimport = manifest.sources.filter((row) => row.status === "REIMPORT_REQUIRED");
  const audit = manifest.audit;
  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Evidence ledger</p>
      <h2 className="font-display mt-0 mb-4 text-xl">Coverage before Council</h2>
      <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Coverage" value={manifest.coverageStatus} />
        <Stat label="Chunks total" value={String(audit.chunksTotal)} />
        <Stat label="Chunks processed" value={String(audit.chunksProcessed)} />
        <Stat label="Chunks with evidence" value={String(audit.chunksWithEvidence)} />
        <Stat label="Chunks without evidence" value={String(audit.chunksWithoutEvidence)} />
        <Stat label="Evidence claims" value={String(audit.evidenceCount)} />
        <Stat label="Packed evidence" value={String(audit.packedEvidence)} />
        <Stat label="Omitted evidence" value={String(audit.omittedEvidence)} />
      </dl>
      <p className="mt-3 mb-0 text-sm text-muted">{manifest.coverageMeaning || COVERAGE_COMPLETE_MEANING}</p>
      {reimport.length > 0 ? (
        <p className="mt-3 mb-0 text-sm text-danger">
          Re-import required for {reimport.map((row) => row.sourceId).join(", ")}. Previously truncated text cannot be recovered.
        </p>
      ) : null}
      <h3 className="mt-6 mb-2 text-sm font-semibold tracking-widest text-muted uppercase">Selected sources</h3>
      <ul className="mt-0 mb-0 grid list-none gap-2 p-0">
        {manifest.sources.length === 0 ? (
          <li className="text-sm text-muted">No selected chats or files.</li>
        ) : (
          manifest.sources.map((row) => (
            <li key={`${row.sourceKind}:${row.sourceId}`} className="rounded-md bg-subtle px-3 py-3 text-sm">
              <StatusPill status={row.status} />{" "}
              <span className="font-medium text-fg">
                {row.sourceKind} {row.sourceId}
              </span>
              <span className="ml-2 font-mono text-xs text-faint">
                {row.processedChunks}/{row.chunkCount} processed · {row.chunksWithEvidence} with evidence ·{" "}
                {row.chunksWithoutEvidence} without · {row.evidenceCount} claims
                {row.cacheHits ? ` · cache ${row.cacheHits}` : ""}
                {row.omittedReason ? ` · ${row.omittedReason}` : ""}
              </span>
            </li>
          ))
        )}
      </ul>
      <h3 className="mt-6 mb-2 text-sm font-semibold tracking-widest text-muted uppercase">Packed citations</h3>
      <ul className="mt-0 mb-0 grid list-none gap-2 p-0">
        {packed.map((row) => {
          const parsed = parseCitation(row.citation);
          const chunk = chunks.find((item) => item.id === row.chunkId);
          const active = open === row.id;
          return (
            <li key={row.id} className="rounded-md bg-subtle px-3 py-3 text-sm">
              <button
                type="button"
                className="m-0 w-full border-0 bg-transparent p-0 text-left text-fg"
                onClick={() => setOpen(active ? null : row.id)}
              >
                <StatusPill status={row.status} /> {row.claim}{" "}
                <span className="font-mono text-xs text-faint">{row.citation}</span>
              </button>
              {active && chunk ? (
                <p className="mt-2 mb-0 font-mono text-xs text-muted">
                  {parsed?.sourceKind} {chunk.sourceId}
                  {chunk.messageSeq != null ? ` · message ${chunk.messageSeq}` : ""}
                  {chunk.fileSpan ? ` · chars ${chunk.fileSpan.start}–${chunk.fileSpan.end}` : ""}
                  <br />
                  {chunk.text.length > 500 ? `${chunk.text.slice(0, 500)}…` : chunk.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-subtle p-4">
      <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
      <dd className="font-display m-0 text-2xl tabular-nums">{value}</dd>
    </div>
  );
}
