import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArtifactPanel, ContextManifestPanel } from "@/components/context-manifest-panel";
import { CouncilFold } from "@/components/council-fold";
import { DecisionRecordPanel } from "@/components/decision-record";
import { CouncilProgressPanel } from "@/components/council-progress";
import { CouncilRunPanel } from "@/components/council-run-panel";
import { CollapsibleText } from "@/components/collapsible-text";
import { PresentedText } from "@/components/presented-text";
import { Crumb, GhostButton, Page, PageHeader, PrimaryButton, StatusPill } from "@/components/council-ui";
import { ImplementationPacketPanel } from "@/components/implementation-packet-panel";
import { OpLogPanel } from "@/components/op-log";
import { isSynthesisResponse, responseMemberId } from "@/lib/council/agents";
import { deriveCouncilReports } from "@/lib/council/reports";
import { deriveDecisionRecord } from "@/lib/council/decision";
import { indexSelectedRepositories } from "@/lib/evidence/repo-index";
import { runCredsFromReady, isStaleDisconnectError } from "@/lib/council/orchestrate";
import { providerName } from "@/lib/council/providers";
import { billingLabel } from "@/lib/council/nano-billing";
import { attemptLimit, memberLabel } from "@/lib/council/members";
import {
  applyCouncilOutput,
  getStoreSnapshot,
  markTaskCancelled,
  markTaskFailed,
  patchTask,
  rememberCouncilProgress,
  rememberManifest,
  rememberResponses,
  useStore,
} from "@/lib/council/store";
import { getCouncilRun, restartCouncilRunFn, startCouncilRun, stopCouncilRunFn, type StartCouncilInput } from "@/lib/council/durable";
import type { DurableRunPublic } from "@/lib/council/durable-run";
import { type CouncilRunSnapshot } from "@/lib/council/run-control";
import { councilPreflight } from "@/lib/council/task-mode";
import { exclusiveRunState } from "@/lib/council/terminal";
import { hasTaskVerdict, kindKey, operatorKind } from "@/lib/council/operator-status";
import { useSession } from "@/lib/council/session";
import type { AgentKey, AgentProgress } from "@/lib/council/types";
import type { EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { formatCouncilOpLog, formatExceptionLog, formatOpLog } from "@/lib/op-log";
import { localizeTaskResult } from "@/lib/i18n/api";
import { englishNarrative, type LocalizedNarrative } from "@/lib/i18n/result-localize";
import { useI18n } from "@/lib/i18n/provider";

export const Route = createFileRoute("/t/$taskId")({ component: TaskPage });


const RUNNING = new Set([
  "QUEUED",
  "PREPARING",
  "COUNCIL_ROUND_1",
  "COUNCIL_ROUND_2",
  "ROUND_1",
  "ROUND_2",
  "SYNTHESIS",
  "FINALIZING",
]);
const STARTABLE = new Set(["CREATED", "FAILED", "CANCELLED"]);

function ListBlock({ title, rows }: { title: string; rows: string[] }) {
  const { t } = useI18n();
  return (
    <>
      <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{title}</h3>
      {rows.length ? (
        <ul className="max-h-log overflow-auto">
          {rows.map((row) => (
            <li key={row} className="break-words">
              {row}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t("task.noneRecorded")}</p>
      )}
    </>
  );
}

function positionForMember(
  positions: Record<string, string>,
  memberId: string,
  members: Array<{ memberId: string; role: string }>,
): string {
  const direct = positions[memberId] || positions[memberId.toLowerCase()];
  if (direct) return direct;
  const member = members.find((row) => row.memberId === memberId);
  if (!member) return "—";
  const sameRole = members.filter((row) => row.role === member.role);
  if (sameRole.length === 1) {
    return positions[member.role] || positions[member.role.toLowerCase()] || "—";
  }
  return "—";
}

function TaskPage() {
  const { taskId } = Route.useParams();
  const store = useStore();
  const { config, creds, setProvider } = useSession();
  const { t, locale } = useI18n();
  const task = store.tasks.find((t) => t.id === taskId);
  const project = store.projects.find((p) => p.id === task?.projectId);
  const context = store.context.filter((c) => c.projectId === task?.projectId);
  const allResponses = store.responses.filter((r) => r.taskId === taskId);
  const result = store.results.find((r) => r.taskId === taskId) ?? null;
  const artifact = store.artifacts.find((row) => row.taskId === taskId) ?? store.artifacts.find((row) => row.id === task?.candidateArtifactId) ?? null;
  const manifest = store.manifests.filter((row) => row.taskId === taskId).at(-1) ?? null;
  const packet =
    store.packets.find((row) => row.taskId === taskId) ??
    store.packets.find((row) => row.reviewTaskId === taskId) ??
    null;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(task?.error ?? "");
  const [log, setLog] = useState("");
  const [stage, setStage] = useState<string>(task?.diagnostics?.run?.stage ?? "PREPARING");
  const [agentState, setAgentState] = useState<Partial<Record<AgentKey, AgentProgress>>>(
    task?.diagnostics?.run?.agents ?? {},
  );
  const [activeRunId, setActiveRunId] = useState(task?.diagnostics?.run?.runId ?? "");
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [narrative, setNarrative] = useState<LocalizedNarrative | null>(null);
  const runGen = useRef(0);
  const applyPublicRef = useRef<(run: DurableRunPublic) => void>(() => undefined);

  useEffect(() => {
    if (!config.ready) return;
    if (isStaleDisconnectError(msg, true)) setMsg("");
    if (task && isStaleDisconnectError(task.error ?? "", true)) {
      patchTask(task.id, { error: null });
    }
  }, [config.ready, msg, task?.id, task?.error]);

  useEffect(() => {
    const running = busy || RUNNING.has(task?.status ?? "");
    if (!taskId || (!running && !activeRunId)) return;
    let cancelled = false;
    async function poll() {
      try {
        const run = await getCouncilRun({ data: { taskId, runId: activeRunId || undefined } });
        if (cancelled || !run) return;
        applyPublicRef.current(run);
      } catch {
        /* reconnect on the next interval */
      }
    }
    void poll();
    const handle = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [taskId, busy, task?.status, activeRunId]);

  useEffect(() => {
    if (locale !== "ru") {
      setNarrative(englishNarrative(result, allResponses));
      return;
    }
    if (!taskId || (!result && allResponses.length === 0)) {
      setNarrative(null);
      return;
    }
    let cancelled = false;
    void localizeTaskResult({ data: { taskId, language: "ru" } })
      .then((out) => {
        if (!cancelled && out.narrative) setNarrative(out.narrative);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, locale, result, allResponses.length]);

  if (!task || !project) {
    return (
      <Page>
        <p className="text-danger">Task not found.</p>
      </Page>
    );
  }

  const currentTask = task;
  const projectArtifacts = store.artifacts.filter((row) => row.projectId === project.id);
  const currentRunId = task.diagnostics?.run?.runId ?? activeRunId;
  const responses = currentRunId ? allResponses.filter((row) => !row.runId || row.runId === currentRunId) : allResponses;
  const priorResponses = currentRunId ? allResponses.filter((row) => row.runId && row.runId !== currentRunId) : [];
  const synth = responses.find((r) => isSynthesisResponse(r) && !r.error);
  const terminal = exclusiveRunState({
    status: task.status,
    snapshotStatus: task.diagnostics?.run?.status,
    taskStatus: task.status,
    result,
    hasSynthesis: Boolean(result),
    hasArtifact: Boolean(result && artifact),
  });
  const opKind = operatorKind({ terminal, hasVerdict: hasTaskVerdict(result) });
  const finished =
    terminal === "FAILED" ||
    terminal === "CANCELLED" ||
    (terminal === "COMPLETE" && hasTaskVerdict(result));
  const isRunning =
    !finished &&
    (busy ||
      RUNNING.has(task.status) ||
      task.diagnostics?.run?.stage === "FINALIZING" ||
      (terminal === "COMPLETE" && !hasTaskVerdict(result)));
  const persistedStage = task.diagnostics?.run?.stage ?? stage;
  const persistedAgents = task.diagnostics?.run?.agents ?? agentState;
  const members = task.selectedModels?.length ? task.selectedModels : config.members;
  const agentList: Array<[AgentKey, string]> = members.map((row) => [row.memberId, memberLabel(row)]);
  const waitingAgents = Object.fromEntries(
    members.map((row) => [row.memberId, { state: "WAITING" as const, attempt: 0, maxAttempts: 3, error: null }]),
  ) as Partial<Record<AgentKey, AgentProgress>>;
  const callLimit = attemptLimit(members.length || 3);

  function applyProgress(
    runId: string,
    progress: {
      status: typeof currentTask.status;
      message: string;
      stage?: string;
      agents?: Partial<Record<AgentKey, AgentProgress>>;
      manifest?: typeof manifest;
      responses?: typeof allResponses;
      snapshot?: CouncilRunSnapshot;
    },
  ) {
    const live = getStoreSnapshot().tasks.find((row) => row.id === currentTask.id);
    if (live?.diagnostics?.run?.runId && live.diagnostics.run.runId !== runId) return;
    if (progress.manifest) rememberManifest(currentTask.id, progress.manifest);
    if (progress.responses?.length) rememberResponses(currentTask.id, progress.responses, { runId });
    if (progress.agents) setAgentState(progress.agents);
    if (progress.stage) setStage(progress.stage);
    if (progress.snapshot) rememberCouncilProgress(currentTask.id, progress.snapshot);
    else patchTask(currentTask.id, { status: progress.status, error: null });
    setMsg(progress.message);
  }

  function applyPublicRun(run: DurableRunPublic) {
    applyProgress(run.runId, {
      status: run.taskStatus,
      message: run.message,
      stage: run.stage,
      agents: run.agents,
      manifest: run.output?.manifest ?? undefined,
      responses: run.responses,
      snapshot: run.snapshot,
    });
    setActiveRunId(run.runId);
    runGen.current = run.generation;
    const runTerminal = exclusiveRunState({
      status: run.status,
      snapshotStatus: run.snapshot?.status,
      taskStatus: run.taskStatus,
      result: run.output?.result ?? null,
      hasSynthesis: Boolean(run.output?.result),
      hasArtifact: Boolean(run.output?.artifact),
    });
    if (run.output && runTerminal) {
      applyCouncilOutput(currentTask.id, run.output);
      setLog(
        formatCouncilOpLog({
          provider: run.provider,
          task: run.output.task,
          responses: run.output.responses,
          result: run.output.result,
        }),
      );
      setBusy(false);
    } else if (runTerminal) {
      setBusy(false);
    } else {
      setBusy(true);
    }
  }
  applyPublicRef.current = applyPublicRun;

  function startPayload(resume?: { responses: typeof allResponses }): StartCouncilInput | null {
    const runCreds = creds ?? runCredsFromReady(config);
    if (!runCreds) return null;
    return {
      taskId: currentTask.id,
      provider: runCreds.provider,
      members: runCreds.members,
      synthesizerModel: runCreds.synthesizerModel,
      maxCostUsd: runCreds.maxCostUsd,
      nanogptBilling: runCreds.nanogptBilling,
      catalog: config.catalog?.models,
      scan: config.catalog ?? null,
      resumeResponses: resume?.responses,
    };
  }

  async function onRun(prepared?: EvidencePipelineResult, opts?: { force?: boolean; resume?: { responses: typeof allResponses } }) {
    const gate = councilPreflight({ task: currentTask, artifacts: projectArtifacts });
    if (!gate.ok) {
      setMsg(gate.error ?? "");
      setLog(
        formatOpLog(
          "council_precheck",
          {
            taskId: currentTask.id,
            mode: currentTask.mode,
            selectedChatSourceIds: currentTask.selectedChatSourceIds,
            error: gate.error,
            providerCalls: 0,
          },
          false,
        ),
      );
      return;
    }
    const payload = startPayload(opts?.resume);
    if (!payload) {
      const text = `${providerName(config.provider)} is not connected. Connect your API key before running the Council.`;
      setMsg(text);
      setLog(
        formatOpLog(
          "council_run",
          {
            provider: config.provider,
            taskId: currentTask.id,
            error: text,
          },
          false,
        ),
      );
      return;
    }
    if (busy && !opts?.force) return;
    patchTask(currentTask.id, {
      provider: payload.provider,
      selectedModels: payload.members,
      nanogptBilling: payload.nanogptBilling ?? null,
      error: null,
    });
    setBusy(true);
    setConfirmRestart(false);
    setMsg(t("operator.queued"));
    setStage("PREPARING");
    setAgentState(waitingAgents);
    try {
      const started = opts?.force
        ? await restartCouncilRunFn({ data: payload })
        : await startCouncilRun({ data: payload });
      applyPublicRun(started);
      setLog(
        formatOpLog(
          "council_run",
          {
            provider: payload.provider,
            taskId: currentTask.id,
            runId: started.runId,
            background: true,
          },
          true,
        ),
      );
    } catch (err) {
      const text = err instanceof Error ? err.message : "Council stopped during request: PROVIDER_ERROR.";
      markTaskFailed(currentTask.id, text);
      setMsg(text);
      setBusy(false);
      setLog(
        formatExceptionLog("council_run", err, {
          provider: config.provider,
          taskId: currentTask.id,
          taskTitle: currentTask.title,
        }),
      );
    }
  }

  function onStop() {
    void (async () => {
      try {
        const stopped = await stopCouncilRunFn({ data: { taskId: currentTask.id, runId: activeRunId || undefined } });
        if (stopped) applyPublicRun(stopped);
        else {
          markTaskCancelled(currentTask.id, "Council run stopped.");
          setMsg("Council run stopped.");
          setStage("CANCELLED");
          setBusy(false);
        }
      } catch {
        markTaskCancelled(currentTask.id, "Council run stopped.");
        setMsg("Council run stopped.");
        setStage("CANCELLED");
        setBusy(false);
      }
    })();
  }

  function onRestart() {
    if (!confirmRestart) {
      setConfirmRestart(true);
      return;
    }
    setConfirmRestart(false);
    void onRun(undefined, { force: true });
  }

  function onRetryFailed() {
    const keep = responses.filter((row) => !row.error);
    void onRun(undefined, { force: true, resume: { responses: keep } });
  }

  const canRun = STARTABLE.has(task.status) && terminal !== "COMPLETE";
  const hashMatch = responses.length === 0 || responses.every((row) => row.contextHash === responses[0]?.contextHash);
  const showPartial =
    !isRunning &&
    task.status === "FAILED" &&
    !synth &&
    (Boolean(task.diagnostics?.run?.partial) || responses.length > 0);
  const reports = deriveCouncilReports({
    mode: task.mode,
    terminal,
    taskStatus: task.status,
    result,
    artifact,
    responses,
    agents: persistedAgents,
    members: members.map((row) => ({ memberId: row.memberId, label: memberLabel(row), role: row.role })),
    running: isRunning,
  });
  const implementation = indexSelectedRepositories({
    files: store.projectFiles.filter(
      (file) => file.projectId === task.projectId && (task.selectedFileIds ?? []).includes(file.id),
    ),
    designMentions: [
      task.canonicalTaskEn || task.prompt,
      artifact?.content ?? "",
      ...context.filter((row) => row.kind !== "RAW_HISTORY").map((row) => row.content),
    ],
  });
  const decision = deriveDecisionRecord({
    mode: task.mode,
    runStatus: terminal === "COMPLETE" || terminal === "FAILED" || terminal === "CANCELLED" ? terminal : null,
    result,
    implementation,
  });
  const showReports = !isRunning && Boolean(terminal || result || showPartial);
  const failedMemberCount = reports.technical.members.filter((row) => row.outcome === "failed").length;

  return (
    <Page>
      <Crumb>
        <Link to="/" className="text-muted">
          {t("nav.projects")}
        </Link>
        {" / "}
        <Link to="/p/$projectId" params={{ projectId: project.id }} className="text-muted">
          {project.name}
        </Link>
        {" / "}
        {task.title}
      </Crumb>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{t("task.modeLine", { mode: task.mode })}</p>
          <PageHeader title={task.originalTitle || task.title}>
            <CollapsibleText text={task.originalTask || task.prompt} />
            {task.originalTask && task.canonicalTaskEn && task.originalTask !== task.canonicalTaskEn ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-faint">{t("task.canonical")}</summary>
                <CollapsibleText text={task.canonicalTaskEn} />
              </details>
            ) : null}
          </PageHeader>
        </div>
        <div className="flex flex-col items-end gap-3">
          <div className="flex flex-col items-end gap-1">
            <p className="m-0 text-xs font-semibold tracking-widest text-muted uppercase">{t("task.run")}</p>
            <StatusPill
              status={opKind === "COMPLETE" ? "COMPLETE" : opKind === "ERROR" ? "FAILED" : opKind === "STOPPED" ? "CANCELLED" : "RUNNING"}
              label={t(kindKey(opKind))}
            />
          </div>
          {hasTaskVerdict(result) ? (
            <div className="flex flex-col items-end gap-1">
              <p className="m-0 text-xs font-semibold tracking-widest text-muted uppercase">{t("task.verdict")}</p>
              <StatusPill status={result!.reconciledStatus ?? result!.finalEnforcedStatus ?? result!.status} />
            </div>
          ) : null}
        </div>
      </header>

      {canRun && !isRunning ? (
        <CouncilRunPanel
          project={project}
          task={task}
          frozen={context}
          chatSources={store.chatSources}
          historyMessages={store.historyMessages}
          artifacts={projectArtifacts}
          projectFiles={store.projectFiles}
          maxCostUsd={config.maxCostUsd}
          ready={config.ready}
          provider={config.provider}
          providerLabel={providerName(config.provider)}
          members={members}
          busy={busy}
          message={isStaleDisconnectError(msg, config.ready) ? "" : msg}
          onRun={(prepared) => void onRun(prepared)}
          onProviderChange={setProvider}
          billing={config.provider === "nanogpt" ? billingLabel(config.nanogptBilling) : null}
        />
      ) : null}

      <ContextManifestPanel
        project={project}
        task={task}
        context={context}
        chatSources={store.chatSources}
        historyMessages={store.historyMessages}
        artifacts={projectArtifacts}
        persisted={manifest}
        projectFiles={store.projectFiles}
      />

      {isRunning ? (
        <CouncilProgressPanel
          terminal={terminal}
          result={result}
          snapshot={task.diagnostics?.run}
          members={members}
          agents={persistedAgents}
          stage={persistedStage}
          message={msg || task.diagnostics?.run?.message || ""}
          providerLabel={providerName(task.diagnostics?.run?.provider ?? task.provider ?? config.provider)}
          billing={
            (task.diagnostics?.run?.provider ?? task.provider ?? config.provider) === "nanogpt"
              ? billingLabel(task.diagnostics?.run?.nanogptBilling ?? task.nanogptBilling ?? config.nanogptBilling)
              : null
          }
          callLimit={callLimit}
          confirmRestart={confirmRestart}
          onStop={onStop}
          onRestart={onRestart}
          onCancelRestart={() => setConfirmRestart(false)}
        />
      ) : null}

      {showReports ? (
        <DecisionRecordPanel record={decision} run={reports.technical} taskId={task.id}>
          {failedMemberCount > 0 && (terminal === "FAILED" || terminal === "COMPLETE") ? (
            <PrimaryButton type="button" disabled={busy} onClick={onRetryFailed}>
              {t("task.retryFailed")}
            </PrimaryButton>
          ) : null}
          {showPartial ? (
            <Link
              to="/settings"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-line bg-transparent px-3.5 py-2.5 font-semibold text-fg no-underline"
            >
              {t("task.replaceFailed")}
            </Link>
          ) : null}
          <GhostButton type="button" onClick={onRestart}>
            {t("task.restart")}
          </GhostButton>
        </DecisionRecordPanel>
      ) : null}
      {showReports && confirmRestart ? (
        <p className="mt-3 mb-0 rounded-md bg-subtle px-3 py-3 text-sm text-muted">
          {t("operator.restartConfirm")}{" "}
          <button type="button" className="font-semibold text-fg underline" onClick={onRestart}>
            {t("operator.confirmRestart")}
          </button>
          {" · "}
          <button type="button" className="text-muted underline" onClick={() => setConfirmRestart(false)}>
            {t("operator.keepResult")}
          </button>
        </p>
      ) : null}

      {showReports ? (
        <CouncilFold
          title={t("fold.repository")}
          summary={
            implementation.conflict
              ? "REPOSITORY_SOURCE_CONFLICT"
              : implementation.missingRepository
                ? t("fold.noRepository")
                : `${implementation.filesIndexed} files · ${implementation.indexerVersion}`
          }
        >
          <p className="mt-0 mb-2 font-mono text-xs break-all text-faint">
            hash {implementation.repositoryHash ?? "none"} · indexer {implementation.indexerVersion}
            {implementation.conflict ? ` · ${implementation.conflict}` : ""}
          </p>
          <ul className="m-0 grid list-none gap-2 p-0">
            {implementation.rows.map((row) => (
              <li key={row.module} className="rounded-md bg-bg px-3 py-2 text-sm">
                <StatusPill status={row.status} label={t(`impl.${row.status}`)} /> {row.module}
                <span className="mt-1 block text-xs text-muted">{row.evidence}</span>
                {row.citations.length ? (
                  <span className="mt-1 block font-mono text-xs break-all text-faint">{row.citations.join(" · ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </CouncilFold>
      ) : null}

      {artifact ? <ArtifactPanel artifact={artifact} /> : null}
      {packet ? <ImplementationPacketPanel packet={packet} /> : null}

      {result ? (
        <CouncilFold title={t("fold.finalFinding")} summary={t("fold.positions")}>
          {result.decision ? (
            <>
              <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("record.outcome")}</h3>
              <PresentedText original={result.decision} localized={narrative?.decision} />
              {result.rationale ? (
                <>
                  <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{t("record.why")}</h3>
                  <PresentedText original={result.rationale} localized={narrative?.rationale} />
                </>
              ) : null}
              <ListBlock title={t("fold.alternatives")} rows={narrative?.alternatives ?? result.alternatives} />
              <ListBlock title={t("fold.dissent")} rows={narrative?.dissent ?? result.dissent} />
              <ListBlock title={t("fold.risks")} rows={narrative?.risks ?? result.risks} />
            </>
          ) : null}
          <h3 className={`${result.decision ? "mt-4" : "mt-0"} text-sm font-semibold tracking-widest text-muted uppercase`}>
            {t("record.recommendations")}
          </h3>
          <PresentedText original={result.recommendation || "—"} localized={narrative?.recommendation} />
          <ListBlock title={t("fold.disagreements")} rows={narrative?.disagreements ?? result.disagreements} />
          <ListBlock title={t("fold.issues")} rows={narrative?.issues ?? result.issues} />
          <ListBlock title={t("fold.corrections")} rows={narrative?.proposedCorrections ?? result.proposedCorrections} />
          <ListBlock title={t("fold.resolvedIssues")} rows={narrative?.resolvedIssues ?? result.resolvedIssues} />
          <ListBlock title={t("fold.openFollowups")} rows={narrative?.unresolvedIssues ?? result.unresolvedIssues} />
          {result.issueLedger ? (
            <>
              <ListBlock
                title={t("fold.ledgerOpen")}
                rows={result.issueLedger.unresolved.map((row) => `${row.issueId} · ${row.severity} · ${row.text}`)}
              />
              <ListBlock
                title={t("fold.ledgerResolved")}
                rows={result.issueLedger.resolved.map((row) => `${row.issueId} · ${row.severity} · ${row.text}`)}
              />
              <ListBlock
                title={t("fold.ledgerRejected")}
                rows={result.issueLedger.rejected.map((row) => `${row.issueId} · ${row.severity} · ${row.text}`)}
              />
              <ListBlock
                title={t("fold.ledgerPatch")}
                rows={result.issueLedger.acceptedAsPatch.map((row) => `${row.issueId} · ${row.severity} · ${row.text}`)}
              />
            </>
          ) : null}
          <ListBlock title={t("fold.citations")} rows={result.citations} />
          {result.evidence.length ? (
            <>
              <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{t("fold.evidence")}</h3>
              <ul className="max-h-log overflow-auto">
                {result.evidence.map((row) => (
                  <li key={row.claim} className="break-words">
                    <StatusPill status={row.status} /> {row.claim}{" "}
                    <span className="font-mono text-xs break-all text-faint">{row.citation ?? "no citation"}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="mt-4">
            <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("fold.modelPosition")}</h3>
            <dl className="m-0 grid gap-3">
              {agentList.map(([key, label]) => (
                <div key={key}>
                  <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
                  <dd className="m-0">
                    <PresentedText
                      original={positionForMember(result.agentPositions, key, members)}
                      localized={
                        narrative?.positions
                          ? positionForMember(narrative.positions, key, members)
                          : null
                      }
                      defaultCollapsed
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {responses[0]?.contextHash ? (
            <p className="mt-3 mb-0 text-xs break-all text-faint">
              Context hash {responses[0].contextHash}
              {hashMatch ? " · all agent responses share this snapshot" : " · snapshot mismatch"}
            </p>
          ) : null}
        </CouncilFold>
      ) : null}

      {responses.length || result ? (
      <div className="grid gap-2">
        {agentList.map(([key, heading]) => {
          const r1 = responses.find(
            (r) => responseMemberId(r) === key && (r.stage === "ROUND_1" || r.round === 1) && !isSynthesisResponse(r),
          );
          const r2 = responses.find(
            (r) => responseMemberId(r) === key && (r.stage === "ROUND_2" || r.round === 2) && !isSynthesisResponse(r),
          );
          const recorded = Boolean(r1 || r2);
          return (
            <CouncilFold key={key} title={heading} summary={recorded ? t("agent.recorded") : t("task.noneRecorded")}>
              <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("fold.modelPosition")}</h3>
              {r1 ? (
                r1.error ? (
                  <p className="text-danger">{narrative?.errors?.[`${key}:${r1.stage ?? r1.round}`] ?? r1.error}</p>
                ) : (
                  <PresentedText original={r1.responseText} localized={narrative?.round1?.[key]} defaultCollapsed />
                )
              ) : (
                <p className="text-muted">{t("task.noneRecorded")}</p>
              )}
              <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{t("fold.crossReview")}</h3>
              {r2 ? (
                r2.error ? (
                  <p className="text-danger">{narrative?.errors?.[`${key}:${r2.stage ?? r2.round}`] ?? r2.error}</p>
                ) : (
                  <PresentedText original={r2.responseText} localized={narrative?.round2?.[key]} defaultCollapsed />
                )
              ) : (
                <p className="text-muted">{t("task.noneRecorded")}</p>
              )}
            </CouncilFold>
          );
        })}

        <CouncilFold
          title={t("fold.rawSynthesis")}
          summary={synth?.responseText || result?.synthesisRaw ? t("agent.recorded") : t("task.noneRecorded")}
        >
          {synth?.responseText || result?.synthesisRaw ? (
            <PresentedText
              original={synth?.responseText || result?.synthesisRaw || ""}
              localized={narrative?.synthesis}
              defaultCollapsed
            />
          ) : (
            <p className="m-0 text-muted">{t("task.noneRecorded")}</p>
          )}
        </CouncilFold>

        <CouncilFold
          title={t("fold.technical")}
          summary={
            task.totalCostUsd != null
              ? `${task.totalCostUsd.toFixed(4)} USD · ${task.totalLatencyMs ?? "—"} ms`
              : "not available"
          }
        >
          <p className="mt-0 mb-3 flex flex-wrap gap-3 text-sm text-muted tabular-nums">
            <span>Council cost: {task.totalCostUsd != null ? `$${task.totalCostUsd.toFixed(4)} (telemetry)` : "telemetry only"}</span>
            <span>
              Calls: {task.diagnostics?.run?.requestBudget?.used ?? responses.length} /{" "}
              {task.diagnostics?.run?.requestBudget?.limit ?? callLimit}
            </span>
            <span>Provider: {providerName(task.provider ?? task.diagnostics?.run?.provider ?? config.provider)}</span>
            {(task.provider ?? task.diagnostics?.run?.provider ?? config.provider) === "nanogpt" ? (
              <span>
                Billing:{" "}
                {billingLabel(task.nanogptBilling ?? task.diagnostics?.run?.nanogptBilling ?? config.nanogptBilling)}
              </span>
            ) : null}
            <span>Input tokens: {task.totalInputTokens ?? "—"}</span>
            <span>Output tokens: {task.totalOutputTokens ?? "—"}</span>
            <span>Total latency: {task.totalLatencyMs != null ? `${task.totalLatencyMs} ms` : "—"}</span>
          </p>
          <pre className="mt-0 max-h-log overflow-auto font-mono text-sm whitespace-pre-wrap break-all text-muted tabular-nums">
            {responses
              .map(
                (row) =>
                  `${responseMemberId(row)} ${row.role} ${row.stage} attempt ${row.attempt ?? "—"} · dispatched=${row.dispatchedModelId || row.model} · in=${row.inputTokens} out=${row.outputTokens} cost=${row.cost} latency=${row.latencyMs} hash=${row.contextHash ?? "—"}`,
              )
              .join("\n") || "Not available."}
          </pre>
        </CouncilFold>
      </div>
      ) : null}

      {priorResponses.length ? (
        <CouncilFold title="Previous runs" summary={`${priorResponses.length} preserved responses`}>
          <pre className="mt-0 max-h-log overflow-auto font-mono text-sm whitespace-pre-wrap break-all text-muted">
            {priorResponses
              .map(
                (row) =>
                  `${row.runId?.slice(0, 8) ?? "legacy"} · ${responseMemberId(row)} ${row.stage} · ${row.error ? "failed" : "kept"}`,
              )
              .join("\n")}
          </pre>
        </CouncilFold>
      ) : null}

      <OpLogPanel
        title="Council log"
        hint="Copy this JSON after a run if something fails. API keys are not included."
        value={log}
        empty="Run Council to capture a detailed log."
      />
    </Page>
  );
}
