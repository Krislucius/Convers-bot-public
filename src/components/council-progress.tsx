import { AgentCard } from "@/components/agent-card";
import { CouncilFold } from "@/components/council-fold";
import { CouncilRunMeter } from "@/components/council-run-panel";
import { DangerButton, GhostButton, Panel, StatusPill } from "@/components/council-ui";
import { PreflightPanel } from "@/components/preflight-panel";
import {
  formatActivityAge,
  kindKey,
  memberOpKey,
  memberOpState,
  operatorKind,
  operatorStage,
  stageKey,
  type OperatorKind,
} from "@/lib/council/operator-status";
import { memberLabel, type CouncilMember } from "@/lib/council/members";
import type { ExclusiveTerminal } from "@/lib/council/terminal";
import type { AgentKey, AgentProgress, CouncilResult } from "@/lib/council/types";
import type { PreflightReport } from "@/lib/council/start-preflight";
import { useI18n } from "@/lib/i18n/provider";

type ProgressSnapshot = {
  stage?: string | null;
  status?: string | null;
  internalStage?: string | null;
  stallReason?: string | null;
  lastProgressAt?: string | null;
  updatedAt?: string | null;
  lastProviderResponseAt?: string | null;
  requestBudget?: {
    used?: number;
    limit?: number;
    preflightCalls?: number;
    councilCalls?: number;
    retries?: number;
  } | null;
  costUsd?: number | null;
  currentMemberId?: string | null;
  currentModelId?: string | null;
  lastWakeAt?: string | null;
  leaseExpiresAt?: string | null;
  nextRecoveryDeadline?: string | null;
  preflight?: unknown;
};

function kindTone(kind: OperatorKind): string {
  if (kind === "COMPLETE") return "COMPLETE";
  if (kind === "ERROR") return "FAILED";
  if (kind === "STOPPED") return "CANCELLED";
  return "RUNNING";
}

export function CouncilProgressPanel({
  terminal,
  result,
  snapshot,
  members,
  agents,
  stage,
  message,
  providerLabel,
  billing,
  callLimit,
  confirmRestart,
  onStop,
  onRestart,
  onCancelRestart,
}: {
  terminal: ExclusiveTerminal | null;
  result: CouncilResult | null;
  snapshot: ProgressSnapshot | null | undefined;
  members: CouncilMember[];
  agents: Partial<Record<AgentKey, AgentProgress>>;
  stage: string;
  message: string;
  providerLabel: string;
  billing?: string | null;
  callLimit: number;
  confirmRestart: boolean;
  onStop: () => void;
  onRestart: () => void;
  onCancelRestart: () => void;
}) {
  const { t, locale, error } = useI18n();
  const kind = operatorKind({
    terminal,
    hasVerdict: Boolean(result?.reconciledStatus ?? result?.status),
  });
  const liveStage = operatorStage({
    stage: snapshot?.stage ?? stage,
    status: snapshot?.status,
    internalStage: snapshot?.internalStage,
    preflightPending: Boolean(snapshot?.preflight && (snapshot.preflight as { status?: string }).status !== "PASS"),
  });
  const used = snapshot?.requestBudget?.used ?? 0;
  const limit = snapshot?.requestBudget?.limit ?? callLimit;
  const activity = formatActivityAge(
    snapshot?.lastProgressAt ?? snapshot?.updatedAt ?? snapshot?.lastProviderResponseAt,
    Date.now(),
    locale,
  );
  const localizedMessage = message ? error(message) : t("operator.queued");

  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{t("task.run")}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display m-0 text-xl">{t(kindKey(kind))}</h2>
        <StatusPill status={kindTone(kind)} label={t(kindKey(kind))} />
      </div>
      {kind === "WORKING" ? (
        <dl className="m-0 grid gap-3">
          <div>
            <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{t("operator.stage")}</dt>
            <dd className="m-0 mt-1">
              <StatusPill status={stageKey(liveStage)} label={t(stageKey(liveStage))} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{t("operator.models")}</dt>
            <dd className="m-0 mt-2">
              <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
                {members.map((member) => {
                  const progress = agents[member.memberId];
                  const state = memberOpState(progress);
                  return (
                    <li key={member.memberId} className="flex items-center justify-between gap-2 rounded-md bg-subtle px-3 py-2">
                      <span className="truncate text-sm text-fg">{memberLabel(member)}</span>
                      <StatusPill status={state} label={t(memberOpKey(state))} />
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{t("operator.progress")}</dt>
            <dd className="m-0 mt-1 text-sm tabular-nums text-fg">{t("operator.progressOf", { done: used, total: limit })}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{t("operator.lastActivity")}</dt>
            <dd className="m-0 mt-1 text-sm tabular-nums text-fg">{activity}</dd>
          </div>
        </dl>
      ) : (
        <p className="m-0 max-w-measure text-sm text-muted">{localizedMessage}</p>
      )}
      <p className="mt-3 mb-0 max-w-measure text-sm text-muted">{t("operator.bgNote")}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <DangerButton type="button" onClick={onStop}>
          {t("task.stop")}
        </DangerButton>
        <GhostButton type="button" onClick={onRestart}>
          {t("task.restart")}
        </GhostButton>
      </div>
      {confirmRestart ? (
        <p className="mt-3 mb-0 rounded-md bg-subtle px-3 py-3 text-sm text-muted">
          {t("operator.restartConfirm")}{" "}
          <button type="button" className="font-semibold text-fg underline" onClick={onRestart}>
            {t("operator.confirmRestart")}
          </button>
          {" · "}
          <button type="button" className="text-muted underline" onClick={onCancelRestart}>
            {t("operator.keepRunning")}
          </button>
        </p>
      ) : null}

      <CouncilFold title={t("operator.technical")} summary={snapshot?.internalStage || snapshot?.stage || stage}>
        {localizedMessage ? <p className="mt-0 mb-3 text-sm text-muted">{localizedMessage}</p> : null}
        <CouncilRunMeter
          provider={providerLabel}
          used={used}
          limit={limit}
          costUsd={snapshot?.costUsd ?? null}
          billing={billing}
        />
        {snapshot?.requestBudget ? (
          <p className="mt-2 mb-0 font-mono text-xs tabular-nums text-faint">
            preflight {snapshot.requestBudget.preflightCalls ?? 0}
            {" · "}council {snapshot.requestBudget.councilCalls ?? 0}
            {" · "}retries {snapshot.requestBudget.retries ?? 0}
          </p>
        ) : null}
        {snapshot?.internalStage ? (
          <p className="mt-2 mb-0 font-mono text-xs break-all text-faint">
            internal {snapshot.internalStage}
            {snapshot.stallReason ? ` · stall ${snapshot.stallReason}` : ""}
            {snapshot.currentMemberId ? ` · member ${snapshot.currentMemberId}` : ""}
            {snapshot.currentModelId ? ` · ${snapshot.currentModelId}` : ""}
          </p>
        ) : null}
        {snapshot?.lastWakeAt || snapshot?.leaseExpiresAt || snapshot?.nextRecoveryDeadline ? (
          <p className="mt-1 mb-0 font-mono text-xs tabular-nums text-faint">
            last wake {snapshot.lastWakeAt ?? "—"}
            {" · "}lease {snapshot.leaseExpiresAt ?? "—"}
            {" · "}next recovery {snapshot.nextRecoveryDeadline ?? "—"}
          </p>
        ) : null}
        <PreflightPanel report={snapshot?.preflight as PreflightReport | null | undefined} />
        <ul className="mt-3 mb-0 grid list-none gap-2 p-0 sm:grid-cols-3">
          {members.map((member) => (
            <AgentCard key={member.memberId} label={memberLabel(member)} progress={agents[member.memberId]} />
          ))}
        </ul>
      </CouncilFold>
    </Panel>
  );
}
