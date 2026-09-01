import { Link } from "@tanstack/react-router";
import { Panel, StatusPill } from "@/components/council-ui";
import { displayVerdict } from "@/lib/council/evaluate";
import type { ProjectQualitySummary } from "@/lib/council/types";

export function QualitySummary({ summary }: { summary: ProjectQualitySummary }) {
  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Evaluation</p>
      <h2 className="font-display mb-3 text-lg">Project quality</h2>
      <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Tasks" value={String(summary.taskCount)} />
        <Stat label="Approved / PASS" value={String(summary.approvedOrPass)} />
        <Stat label="PATCH" value={String(summary.patch)} />
        <Stat label="BLOCKED" value={String(summary.blocked)} />
        <Stat label="Disagreements" value={String(summary.disagreements)} />
        <Stat label="Evidence used" value={String(summary.evidenceUsed)} />
        <Stat label="Iterations" value={String(summary.iterations)} />
        <Stat label="Later corrections" value={String(summary.laterCorrections)} />
      </dl>
      {summary.rows.length ? (
        <ul className="mt-4 mb-0 grid list-none gap-2 p-0">
          {summary.rows.map((row) => (
            <li key={row.taskId}>
              <Link
                to="/t/$taskId"
                params={{ taskId: row.taskId }}
                className="grid gap-1 rounded-md border border-line bg-subtle p-3 no-underline hover:border-line-strong"
              >
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <strong className="text-fg">{row.mode}</strong>
                  <StatusPill status={displayVerdict(row.reviewVerdict, row.councilOutcome)} />
                  {row.packetStatus ? <StatusPill status={row.packetStatus} /> : null}
                </span>
                <span className="text-xs text-faint tabular-nums">
                  disagreements {row.disagreements} · evidence {row.evidenceUsed} · iteration {row.iteration}
                  {row.laterCorrection ? " · later correction" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 mb-0 text-sm text-muted">No evaluated tasks yet.</p>
      )}
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
