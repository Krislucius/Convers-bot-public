import type { ReactNode } from "react";
import { Panel, StatusPill } from "@/components/council-ui";
import type { DecisionBlocker, DecisionRecord, DecisionResolved, NextAction } from "@/lib/council/decision";
import type { TechnicalReport } from "@/lib/council/reports";

function nextActionTone(action: NextAction): string {
  if (action === "ACCEPT") return "APPROVED";
  if (action === "CREATE PATCH") return "PATCH";
  if (action === "RUN DECIDE" || action === "REQUEST MORE EVIDENCE") return "USER_DECISION_REQUIRED";
  return "PREPARING";
}

function recordAccent(verdict: DecisionRecord["verdict"]): string {
  if (verdict === "BLOCKED") return "border-l-4 border-l-danger";
  if (verdict === "PATCH" || verdict === "USER_DECISION_REQUIRED") return "border-l-4 border-l-warn";
  if (verdict === "APPROVED") return "border-l-4 border-l-ok";
  return "border-l-4 border-l-line-strong";
}

function BlockerCard({ row }: { row: DecisionBlocker }) {
  return (
    <li className="rounded-md bg-subtle px-3 py-3">
      <p className="m-0 mb-1 font-mono text-xs tracking-wide text-faint uppercase">
        {row.issueId} · {row.severity}
      </p>
      <p className="m-0 text-sm font-semibold break-words text-fg">{row.title}</p>
      <p className="m-0 mt-2 text-sm text-muted">{row.why}</p>
      {row.evidenceRefs.length ? (
        <p className="m-0 mt-2 font-mono text-xs break-all text-faint">{row.evidenceRefs.join(" · ")}</p>
      ) : null}
      <p className="m-0 mt-2 text-xs text-faint">
        supporting {row.supportingRoles.join(", ") || "—"}
        {" · "}
        opposing {row.opposingRoles.join(", ") || "—"}
      </p>
      <p className="m-0 mt-2 text-sm text-fg">{row.resolveCondition}</p>
    </li>
  );
}

function ResolvedRow({ row }: { row: DecisionResolved }) {
  return (
    <li className="text-sm break-words text-muted">
      <span className="font-mono text-xs text-faint">{row.issueId}</span>
      {" · "}
      {row.title}
      {" — "}
      {row.reason}
    </li>
  );
}

export function DecisionRecordPanel({
  record,
  run,
  children,
}: {
  record: DecisionRecord;
  run?: TechnicalReport | null;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-4">
      <Panel className={recordAccent(record.verdict)}>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Decision record</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-widest text-muted uppercase">Run</span>
          <StatusPill status={record.runStatus ?? "CREATED"} />
          <span className="text-xs font-semibold tracking-widest text-muted uppercase">Verdict</span>
          {record.verdict ? (
            <StatusPill status={record.verdict} />
          ) : (
            <span className="text-sm text-faint">none</span>
          )}
        </div>
        <h2 className="font-display m-0 text-2xl text-balance">{record.conclusion}</h2>

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Why</h3>
        <p className="m-0 max-w-measure text-sm text-muted">{record.why}</p>

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Agreed</h3>
        {record.agreed.length ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {record.agreed.map((row) => (
              <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
                {row}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">None recorded.</p>
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Open blockers</h3>
        {record.blockers.length ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {record.blockers.map((row) => (
              <BlockerCard key={row.issueId} row={row} />
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">None.</p>
        )}

        {record.userDecisions.length ? (
          <>
            <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">User decisions</h3>
            <ul className="m-0 grid list-none gap-2 p-0">
              {record.userDecisions.map((row) => (
                <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
                  {row}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Next action</h3>
        {record.nextAction ? (
          <p className="m-0 text-sm">
            <StatusPill status={nextActionTone(record.nextAction)} label={record.nextAction} />
            <span className="mt-2 block max-w-measure text-muted">{record.nextActionWhy}</span>
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">{record.nextActionWhy}</p>
        )}

        {record.resolved.length ? (
          <>
            <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Resolved</h3>
            <ul className="m-0 grid list-none gap-1 p-0">
              {record.resolved.map((row) => (
                <ResolvedRow key={`${row.issueId}-${row.disposition}`} row={row} />
              ))}
            </ul>
          </>
        ) : null}
      </Panel>

      {run && (run.kind === "FAILED" || run.kind === "FINISHED_WITH_GAPS" || run.kind === "CANCELLED") ? (
        <Panel className={`border-l-4 ${run.kind === "FAILED" ? "border-l-danger" : "border-l-warn"}`}>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Council run</p>
          <h2 className="font-display m-0 text-xl">{run.headline}</h2>
          <p className="mt-2 mb-0 max-w-measure text-sm text-muted">{run.summary}</p>
          {run.members.filter((row) => row.outcome === "failed").length ? (
            <ul className="mt-3 mb-0 grid list-none gap-2 p-0">
              {run.members
                .filter((row) => row.outcome === "failed")
                .map((row) => (
                  <li key={row.memberId} className="text-sm text-danger">
                    {row.label}: {row.reason ?? "failed"}
                  </li>
                ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
