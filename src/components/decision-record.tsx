import { useEffect, useState, type ReactNode } from "react";
import { Panel, StatusPill } from "@/components/council-ui";
import type { DecisionBlocker, DecisionRecord, DecisionResolved, NextAction } from "@/lib/council/decision";
import type { TechnicalReport } from "@/lib/council/reports";
import { localizeTaskResult } from "@/lib/i18n/api";
import { localizeDecisionRecordStatic, type LocalizedDecisionView } from "@/lib/i18n/result-localize";
import { useI18n } from "@/lib/i18n/provider";

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

function BlockerCard({ row, t }: { row: DecisionBlocker; t: (key: string) => string }) {
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
        {t("record.supporting")} {row.supportingRoles.join(", ") || "—"}
        {" · "}
        {t("record.opposing")} {row.opposingRoles.join(", ") || "—"}
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
  taskId,
  children,
}: {
  record: DecisionRecord;
  run?: TechnicalReport | null;
  taskId?: string;
  children?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const [view, setView] = useState<LocalizedDecisionView>(() => localizeDecisionRecordStatic(record, locale));

  useEffect(() => {
    const staticView = localizeDecisionRecordStatic(record, locale);
    setView(staticView);
    if (locale !== "ru" || !taskId) return;
    let cancelled = false;
    void localizeTaskResult({ data: { taskId, language: "ru" } })
      .then((out) => {
        if (!cancelled && out.view) setView(out.view);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [record, locale, taskId]);

  return (
    <div className="grid gap-4">
      <Panel className={recordAccent(view.verdict)}>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.title")}</p>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold tracking-widest text-muted uppercase">{t("task.run")}</span>
          <StatusPill status={view.runStatus ?? "CREATED"} />
          <span className="text-xs font-semibold tracking-widest text-muted uppercase">{t("task.verdict")}</span>
          {view.verdict ? (
            <StatusPill status={view.verdict} label={view.verdictLabel ?? undefined} />
          ) : (
            <span className="text-sm text-faint">{t("status.none")}</span>
          )}
        </div>
        <h2 className="font-display m-0 text-2xl text-balance">{view.conclusion}</h2>

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.why")}</h3>
        <p className="m-0 max-w-measure text-sm text-muted">{view.why}</p>

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.agreed")}</h3>
        {view.agreed.length ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {view.agreed.map((row) => (
              <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
                {row}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">{t("task.noneRecorded")}</p>
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.blockers")}</h3>
        {view.blockers.length ? (
          <ul className="m-0 grid list-none gap-2 p-0">
            {view.blockers.map((row) => (
              <BlockerCard key={row.issueId} row={row} t={t} />
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted">{t("record.none")}</p>
        )}

        {view.userDecisions.length ? (
          <>
            <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.userDecisions")}</h3>
            <ul className="m-0 grid list-none gap-2 p-0">
              {view.userDecisions.map((row) => (
                <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
                  {row}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.next")}</h3>
        {view.nextAction ? (
          <p className="m-0 text-sm">
            <StatusPill status={nextActionTone(view.nextAction)} label={view.nextActionLabel ?? view.nextAction} />
            <span className="mt-2 block max-w-measure text-muted">{view.nextActionWhy}</span>
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">{view.nextActionWhy}</p>
        )}

        {view.resolved.length ? (
          <>
            <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.resolved")}</h3>
            <ul className="m-0 grid list-none gap-1 p-0">
              {view.resolved.map((row) => (
                <ResolvedRow key={`${row.issueId}-${row.disposition}`} row={row} />
              ))}
            </ul>
          </>
        ) : null}
      </Panel>

      {run && (run.kind === "FAILED" || run.kind === "FINISHED_WITH_GAPS" || run.kind === "CANCELLED") ? (
        <Panel className={`border-l-4 ${run.kind === "FAILED" ? "border-l-danger" : "border-l-warn"}`}>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{t("app.name")}</p>
          <h2 className="font-display m-0 text-xl">{run.headline}</h2>
          <p className="mt-2 mb-0 max-w-measure text-sm text-muted">{run.summary}</p>
          {run.members.filter((row) => row.outcome === "failed").length ? (
            <ul className="mt-3 mb-0 grid list-none gap-2 p-0">
              {run.members
                .filter((row) => row.outcome === "failed")
                .map((row) => (
                  <li key={row.memberId} className="text-sm text-danger">
                    {row.label}: {row.reason ?? t("status.FAILED")}
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