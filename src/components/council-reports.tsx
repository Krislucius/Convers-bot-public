import type { ReactNode } from "react";
import { Panel } from "@/components/council-ui";
import type { CouncilReports, MemberOutcome, SubstanceKind, TechnicalKind } from "@/lib/council/reports";

function technicalTone(kind: TechnicalKind): string {
  if (kind === "FINISHED") return "border-l-ok";
  if (kind === "FINISHED_WITH_GAPS") return "border-l-warn";
  if (kind === "FAILED") return "border-l-danger";
  if (kind === "CANCELLED") return "border-l-faint";
  return "border-l-info";
}

function substanceTone(kind: SubstanceKind): string {
  if (kind === "CREATED" || kind === "ACCEPTED") return "border-l-ok";
  if (kind === "NEEDS_PATCH" || kind === "NEEDS_DECISION") return "border-l-warn";
  if (kind === "CANNOT_ACCEPT") return "border-l-danger";
  return "border-l-line-strong";
}

function outcomeTone(outcome: MemberOutcome["outcome"]): string {
  if (outcome === "completed") return "text-ok";
  if (outcome === "failed") return "text-danger";
  if (outcome === "running") return "text-warn";
  return "text-faint";
}

function outcomeLabel(row: MemberOutcome): string {
  if (row.outcome === "completed") return "completed role";
  if (row.outcome === "failed") return row.reason ? `failed — ${row.reason}` : "failed";
  if (row.outcome === "running") return "running";
  if (row.outcome === "waiting") return "waiting";
  return row.reason ?? "did not run";
}

function NamedList({ title, rows }: { title: string; rows: string[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <h3 className="mt-0 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{title}</h3>
      <ul className="m-0 grid list-none gap-2 p-0">
        {rows.map((row) => (
          <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
            {row}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CouncilReports({
  reports,
  children,
}: {
  reports: CouncilReports;
  children?: ReactNode;
}) {
  const { technical, substance } = reports;
  return (
    <div className="grid gap-4">
      <Panel className={`border-l-4 ${technicalTone(technical.kind)}`}>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">1 · Council run</p>
        <h2 className="font-display m-0 text-2xl text-balance">{technical.headline}</h2>
        <p className="mt-2 mb-0 max-w-measure text-sm text-muted">{technical.summary}</p>
        {technical.members.length ? (
          <ul className="mt-4 mb-0 grid list-none gap-2 p-0">
            {technical.members.map((row) => (
              <li key={row.memberId} className="rounded-md bg-subtle px-3 py-3">
                <p className="m-0 text-sm font-semibold text-fg">{row.label}</p>
                <p className={`m-0 mt-1 text-sm ${outcomeTone(row.outcome)}`}>{outcomeLabel(row)}</p>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="mt-3 mb-0 text-xs tracking-wider text-faint uppercase">
          Synthesis {technical.synthesis}
        </p>
      </Panel>
      <Panel className={`border-l-4 ${substanceTone(substance.kind)}`}>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">2 · Task verdict</p>
        <h2 className="font-display m-0 text-2xl text-balance">{substance.headline}</h2>
        <p className="mt-2 mb-0 max-w-measure text-sm text-muted">{substance.summary}</p>
        {substance.created ? (
          <p className="mt-3 mb-0 text-sm">
            <span className="text-xs font-semibold tracking-widest text-muted uppercase">Created</span>
            <span className="mt-1 block break-words text-fg">{substance.created}</span>
          </p>
        ) : null}
        <NamedList title="What Council discussed" rows={substance.discussed} />
        <NamedList title="Why it cannot be accepted" rows={substance.cannotAccept} />
        <NamedList title="To continue or improve" rows={substance.next} />
      </Panel>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
