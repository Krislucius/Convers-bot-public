import { useEffect, useState, type ReactNode } from "react";
import { Panel, PrimaryButton, StatusPill } from "@/components/council-ui";
import type { DecisionRecord, DecisionResolved, NextAction } from "@/lib/council/decision";
import type { TechnicalReport } from "@/lib/council/reports";
import type { ImplementationRow } from "@/lib/evidence/repo-index";
import { localizeTaskResult } from "@/lib/i18n/api";
import { localizeDecisionRecordStatic, type LocalizedDecisionView } from "@/lib/i18n/result-localize";
import { useI18n } from "@/lib/i18n/provider";

function nextActionTone(action: NextAction): string {
  if (action === "ACCEPT") return "APPROVED";
  if (action === "CREATE_PATCH") return "PATCH";
  if (action === "RUN_DECIDE" || action === "ADD_EVIDENCE" || action === "ADD_REPOSITORY_EVIDENCE") {
    return "USER_DECISION_REQUIRED";
  }
  if (action === "RUN_REVIEW") return "READY_FOR_REVIEW";
  return "PREPARING";
}

function recordAccent(verdict: DecisionRecord["verdict"]): string {
  if (verdict === "BLOCKED") return "border-l-4 border-l-danger";
  if (verdict === "PATCH" || verdict === "USER_DECISION_REQUIRED") return "border-l-4 border-l-warn";
  if (verdict === "APPROVED") return "border-l-4 border-l-ok";
  if (verdict === "READY_FOR_REVIEW") return "border-l-4 border-l-line-strong";
  return "border-l-4 border-l-line-strong";
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

function TextList({ rows, empty }: { rows: string[]; empty: string }) {
  if (!rows.length) return <p className="m-0 text-sm text-muted">{empty}</p>;
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {rows.map((row) => (
        <li key={row} className="rounded-md bg-subtle px-3 py-2 text-sm break-words text-fg">
          {row}
        </li>
      ))}
    </ul>
  );
}

function ImplementationList({
  rows,
  t,
}: {
  rows: ImplementationRow[];
  t: (key: string) => string;
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {rows.map((row) => (
        <li key={row.module} className="rounded-md bg-subtle px-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-fg">{row.module}</span>
            <StatusPill status={row.status} label={t(`impl.${row.status}`)} />
          </div>
          <p className="m-0 mt-2 text-sm text-muted">{row.evidence}</p>
          {row.citations.length ? (
            <p className="m-0 mt-2 font-mono text-xs break-all text-faint">{row.citations.join(" · ")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function OriginalEnglish({ record, t }: { record: DecisionRecord; t: (key: string) => string }) {
  const lists: Array<{ label: string; rows: string[] }> = [
    { label: t("record.completed"), rows: record.completed.length ? record.completed : record.agreed },
    { label: t("record.notCompleted"), rows: record.notCompleted },
    { label: t("record.implementation"), rows: record.implementationNotes },
    { label: t("record.blockers"), rows: record.blockerNotes.length ? record.blockerNotes : record.blockers.map((row) => row.title) },
    { label: t("record.recommendations"), rows: record.recommendations },
    { label: t("record.required"), rows: record.required },
    { label: t("record.userActions"), rows: record.userActions.length ? record.userActions : record.userDecisions },
  ];
  return (
    <details className="mt-5">
      <summary className="cursor-pointer text-xs font-semibold tracking-widest text-muted uppercase">
        {t("fold.originalEn")}
      </summary>
      <p className="mt-3 mb-0 max-w-measure text-sm text-muted">{record.summary || record.conclusion}</p>
      {lists.map((block) =>
        block.rows.length ? (
          <div key={block.label} className="mt-3">
            <p className="m-0 mb-1 text-xs tracking-widest text-faint uppercase">{block.label}</p>
            <ul className="m-0 grid list-none gap-1 p-0">
              {block.rows.map((row) => (
                <li key={row} className="text-sm text-muted">
                  {row}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {record.nextActionWhy ? (
        <p className="mt-3 mb-0 text-sm text-muted">
          {t("record.next")}: {record.nextActionWhy}
        </p>
      ) : null}
    </details>
  );
}

export function DecisionRecordPanel({
  record,
  run,
  taskId,
  onFollowOn,
  followOnBusy,
  acceptedCount,
  children,
}: {
  record: DecisionRecord;
  run?: TechnicalReport | null;
  taskId?: string;
  onFollowOn?: (action: NextAction) => void;
  followOnBusy?: boolean;
  acceptedCount?: number | null;
  children?: ReactNode;
}) {
  const { t, locale, error } = useI18n();
  const [view, setView] = useState<LocalizedDecisionView>(() => localizeDecisionRecordStatic(record, locale));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const staticView = localizeDecisionRecordStatic(record, locale);
    setView(staticView);
    setFailed(false);
    if (locale !== "ru" || !taskId) return;
    let cancelled = false;
    void localizeTaskResult({ data: { taskId, language: "ru" } })
      .then((out) => {
        if (cancelled) return;
        if (out.error) {
          setFailed(true);
          if (out.view) setView(out.view);
          return;
        }
        if (out.view) setView(out.view);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [record, locale, taskId]);

  const pendingRu = locale === "ru" && !view.fromCache && !failed;
  const showOriginal = locale === "ru" && (view.fromCache || failed);
  const blockerRows = view.blockerNotes.length ? view.blockerNotes : view.blockers.map((row) => row.title);

  return (
    <div className="grid gap-4">
      <Panel className={recordAccent(view.verdict)}>
        <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.title")}</p>

        <h3 className="mt-0 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.outcome")}</h3>
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
        {pendingRu ? (
          <p className="m-0 max-w-measure text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <>
            {failed ? <p className="m-0 mb-2 text-sm text-warn">{t("record.translationFailed")}</p> : null}
            <h2 className="font-display m-0 text-2xl text-balance">{view.summary || view.conclusion}</h2>
            <p className="m-0 mt-2 max-w-measure text-sm text-muted">{view.why}</p>
          </>
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.completed")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList rows={view.completed.length ? view.completed : view.agreed} empty={t("task.noneRecorded")} />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.notCompleted")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList rows={view.notCompleted} empty={t("record.noneIdentified")} />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.implementation")}</h3>
        {pendingRu ? (
          <p className="m-0 mb-3 text-sm text-muted">{t("record.translating")}</p>
        ) : view.implementationNotes.length ? (
          <div className="mb-3">
            <TextList rows={view.implementationNotes} empty={t("record.noneIdentified")} />
          </div>
        ) : null}
        <ImplementationList rows={view.implementationState} t={t} />

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.blockers")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList rows={blockerRows} empty={t("record.noBlockers")} />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.recommendations")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList rows={view.recommendations} empty={t("record.none")} />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.required")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList rows={view.required} empty={t("record.noneRequired")} />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.userActions")}</h3>
        {pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : (
          <TextList
            rows={view.userActions.length ? view.userActions : view.userDecisions}
            empty={t("record.noUserAction")}
          />
        )}

        <h3 className="mt-5 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("record.next")}</h3>
        {view.nextAction && view.nextAction !== "NO_ACTION" && onFollowOn ? (
          <div className="grid gap-2">
            <PrimaryButton
              type="button"
              disabled={Boolean(followOnBusy) || acceptedCount != null}
              onClick={() => {
                if (view.nextAction && view.nextAction !== "NO_ACTION") onFollowOn(view.nextAction);
              }}
            >
              {followOnBusy ? t("follow.busy") : (view.nextActionLabel ?? view.nextAction)}
            </PrimaryButton>
            {pendingRu ? (
              <p className="m-0 max-w-measure text-sm text-muted">{t("record.translating")}</p>
            ) : (
              <p className="m-0 max-w-measure text-sm text-muted">{view.nextActionWhy}</p>
            )}
            <p className="m-0 max-w-measure text-xs text-faint">{t(`follow.${view.nextAction}`)}</p>
            {acceptedCount != null ? (
              <p className="m-0 text-sm text-ok">{t("follow.done", { count: acceptedCount })}</p>
            ) : null}
          </div>
        ) : pendingRu ? (
          <p className="m-0 text-sm text-muted">{t("record.translating")}</p>
        ) : view.nextAction ? (
          <p className="m-0 text-sm">
            <StatusPill status={nextActionTone(view.nextAction)} label={view.nextActionLabel ?? view.nextAction} />
            <span className="mt-2 block max-w-measure text-muted">{view.nextActionWhy}</span>
          </p>
        ) : (
          <p className="m-0 text-sm text-muted">{view.nextActionWhy}</p>
        )}

        {view.resolved.length && !pendingRu ? (
          <details className="mt-5">
            <summary className="cursor-pointer text-xs font-semibold tracking-widest text-muted uppercase">
              {t("record.resolved")}
            </summary>
            <ul className="mt-2 mb-0 grid list-none gap-1 p-0">
              {view.resolved.map((row) => (
                <ResolvedRow key={`${row.issueId}-${row.disposition}`} row={row} />
              ))}
            </ul>
          </details>
        ) : null}

        {showOriginal ? <OriginalEnglish record={record} t={t} /> : null}
      </Panel>

      {run && (run.kind === "FAILED" || run.kind === "FINISHED_WITH_GAPS" || run.kind === "CANCELLED") ? (
        <Panel className={`border-l-4 ${run.kind === "FAILED" ? "border-l-danger" : "border-l-warn"}`}>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{t("app.name")}</p>
          <h2 className="font-display m-0 text-xl">{error(run.headline)}</h2>
          <p className="mt-2 mb-0 max-w-measure text-sm text-muted">{error(run.summary)}</p>
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
