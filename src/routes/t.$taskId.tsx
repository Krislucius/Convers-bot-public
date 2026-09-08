import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AgentCard } from "@/components/agent-card";
import { PreflightPanel } from "@/components/preflight-panel";
import { ArtifactPanel, ContextManifestPanel } from "@/components/context-manifest-panel";
import { CouncilFold } from "@/components/council-fold";
import { CouncilRunPanel, CouncilRunMeter } from "@/components/council-run-panel";
import { CollapsibleText } from "@/components/collapsible-text";
import { Crumb, DangerButton, GhostButton, Page, PageHeader, Panel, PrimaryButton, StatusPill } from "@/components/council-ui";
import { ImplementationPacketPanel } from "@/components/implementation-packet-panel";
import { OpLogPanel } from "@/components/op-log";
import { displayVerdict } from "@/lib/council/evaluate";
import { councilPartial, isSynthesisResponse, responseMemberId } from "@/lib/council/agents";
import { runCredsFromReady, isStaleDisconnectError } from "@/lib/council/orchestrate";
import { providerName } from "@/lib/council/providers";
import { billingLabel } from "@/lib/council/nano-billing";
import { attemptLimit, findMember, memberLabel } from "@/lib/council/members";
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
import { useSession } from "@/lib/council/session";
import type { AgentKey, AgentProgress } from "@/lib/council/types";
import type { EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { formatCouncilOpLog, formatExceptionLog, formatOpLog } from "@/lib/op-log";

export const Route = createFileRoute("/t/$taskId")({ component: TaskPage });


const RUNNING = new Set(["PREPARING", "COUNCIL_ROUND_1", "COUNCIL_ROUND_2", "SYNTHESIS"]);
const STARTABLE = new Set(["CREATED", "FAILED", "CANCELLED"]);

function ListBlock({ title, rows }: { title: string; rows: string[] }) {
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
        <p className="text-muted">None recorded.</p>
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

  if (!task || !project) {
    return (
      <Page>
        <p className="text-danger">Task not found.</p>
      </Page>
    );
  }

  const currentTask = task;
  const projectArtifacts = store.artifacts.filter((row) => row.projectId === project.id);
  const isRunning = busy || RUNNING.has(task.status);
  const currentRunId = task.diagnostics?.run?.runId ?? activeRunId;
  const responses = currentRunId ? allResponses.filter((row) => !row.runId || row.runId === currentRunId) : allResponses;
  const priorResponses = currentRunId ? allResponses.filter((row) => row.runId && row.runId !== currentRunId) : [];
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
    if (run.output && (run.status === "COMPLETE" || run.status === "FAILED" || run.status === "CANCELLED")) {
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
    setMsg("Queued on the server. Running in background.");
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

  const synth = responses.find((r) => isSynthesisResponse(r) && !r.error);
  const canRun = STARTABLE.has(task.status);
  const hashMatch = responses.length === 0 || responses.every((row) => row.contextHash === responses[0]?.contextHash);
  const round1Rows = responses.filter((row) => row.stage === "ROUND_1" || row.round === 1);
  const workRows = responses.filter((row) => !isSynthesisResponse(row));
  const partialInfo = councilPartial(round1Rows.length ? round1Rows : workRows);
  const showPartial =
    !isRunning &&
    task.status === "FAILED" &&
    !synth &&
    (Boolean(task.diagnostics?.run?.partial) || responses.length > 0);

  return (
    <Page>
      <Crumb>
        <Link to="/" className="text-muted">
          Projects
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
          <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{task.mode} task</p>
          <PageHeader title={task.title}>
            <CollapsibleText text={task.prompt} />
          </PageHeader>
        </div>
        <StatusPill status={task.status} />
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
        <Panel>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Running in background</p>
          <h2 className="font-display mb-2 text-xl">Council is running on the server</h2>
          <p className="text-muted">{msg || task.diagnostics?.run?.message || "Queued…"}</p>
          {task.diagnostics?.run?.stallReason ? (
            <p className="mt-2 mb-0 text-sm text-warn">
              STALL {task.diagnostics.run.stallReason}
              {task.diagnostics.run.currentMemberId ? ` · member ${task.diagnostics.run.currentMemberId}` : ""}
              {task.diagnostics.run.currentModelId ? ` · ${task.diagnostics.run.currentModelId}` : ""}
            </p>
          ) : task.diagnostics?.run?.internalStage ? (
            <p className="mt-2 mb-0 text-sm text-muted">
              stage {task.diagnostics.run.internalStage}
              {task.diagnostics.run.currentMemberId ? ` · member ${task.diagnostics.run.currentMemberId}` : ""}
              {task.diagnostics.run.currentModelId ? ` · ${task.diagnostics.run.currentModelId}` : ""}
            </p>
          ) : null}
          <p className="mt-2 mb-0 text-sm text-muted">
            You can close this page, reload, or sign out. This run keeps going until it finishes or you Stop it.
          </p>
          <p className="mt-3 mb-0 text-sm tabular-nums">
            Started {task.diagnostics?.run?.startedAt ?? "just now"}
            {" · "}
            last progress {task.diagnostics?.run?.updatedAt ?? task.diagnostics?.run?.stageStartedAt ?? "pending"}
          </p>
          <p className="mt-1 mb-0 text-xs tabular-nums text-faint">
            last wake {task.diagnostics?.run?.lastWakeAt ?? "pending"}
            {" · "}
            lease {task.diagnostics?.run?.leaseExpiresAt ?? "none"}
            {" · "}
            next recovery {task.diagnostics?.run?.nextRecoveryDeadline ?? "pending"}
          </p>
          <div className="mt-3">
            <CouncilRunMeter
              provider={providerName(task.diagnostics?.run?.provider ?? task.provider ?? config.provider)}
              used={task.diagnostics?.run?.requestBudget?.used ?? 0}
              limit={task.diagnostics?.run?.requestBudget?.limit ?? callLimit}
              costUsd={task.diagnostics?.run?.costUsd ?? task.totalCostUsd}
              billing={
                (task.diagnostics?.run?.provider ?? task.provider ?? config.provider) === "nanogpt"
                  ? billingLabel(task.diagnostics?.run?.nanogptBilling ?? task.nanogptBilling ?? config.nanogptBilling)
                  : null
              }
            />
            {task.diagnostics?.run?.requestBudget ? (
              <p className="mt-1 mb-0 font-mono text-xs tabular-nums text-faint">
                preflight {task.diagnostics.run.requestBudget.preflightCalls ?? 0}
                {" · "}council {task.diagnostics.run.requestBudget.councilCalls ?? 0}
                {" · "}retries {task.diagnostics.run.requestBudget.retries ?? 0}
              </p>
            ) : null}
          </div>
          <PreflightPanel report={task.diagnostics?.run?.preflight} />
          <p className="mt-3 mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{persistedStage}</p>
          <p className="m-0 mb-3 text-xs text-faint">
            Stage started {task.diagnostics?.run?.stageStartedAt ?? "just now"}
            {task.diagnostics?.run?.updatedAt ? ` · updated ${task.diagnostics.run.updatedAt}` : ""}
          </p>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
            {agentList.map(([agent, label]) => (
              <AgentCard key={agent} label={label} progress={persistedAgents[agent] ?? agentState[agent]} />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <DangerButton type="button" onClick={onStop}>
              Stop
            </DangerButton>
            <GhostButton type="button" onClick={onRestart}>
              Restart
            </GhostButton>
          </div>
          {confirmRestart ? (
            <p className="mt-3 mb-0 rounded-md bg-subtle px-3 py-3 text-sm text-muted">
              Restart starts a new Council run and may incur new API cost.{" "}
              <button type="button" className="font-semibold text-fg underline" onClick={onRestart}>
                Confirm restart
              </button>
              {" · "}
              <button type="button" className="text-muted underline" onClick={() => setConfirmRestart(false)}>
                Keep running
              </button>
            </p>
          ) : null}
        </Panel>
      ) : null}

      {showPartial ? (
        <Panel>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Failed run</p>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="font-display m-0 text-xl">Partial result</h2>
            <StatusPill status="PARTIAL" />
          </div>
          <p className="m-0 max-w-measure text-sm text-muted">
            {task.diagnostics?.run?.synthesisSkipped ||
              partialInfo.reason ||
              "Synthesis was not created because fewer than 2 models survived."}
          </p>
          <ul className="mt-4 mb-0 grid list-none gap-2 p-0 sm:grid-cols-3">
            {agentList.map(([agent, label]) => (
              <AgentCard key={agent} label={label} progress={persistedAgents[agent] ?? agentState[agent]} />
            ))}
          </ul>
          <div className="mt-4 grid gap-3">
            {workRows
              .filter((row) => !row.error)
              .map((row) => {
                const member = findMember(members, row);
                return (
                  <div key={row.id} className="rounded-md border border-line bg-subtle px-3 py-3">
                    <p className="m-0 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">
                      {member ? memberLabel(member) : row.role || responseMemberId(row)} ·{" "}
                      {row.stage === "ROUND_2" ? "cross-review" : "position"}
                    </p>
                    <CollapsibleText text={row.responseText} defaultCollapsed />
                  </div>
                );
              })}
            {responses
              .filter((row) => isSynthesisResponse(row) && row.error)
              .map((row) => (
                <div key={row.id} className="rounded-md border border-line bg-subtle px-3 py-3">
                  <p className="m-0 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">
                    Synthesis failure · {row.role || responseMemberId(row)}
                  </p>
                  <p className="m-0 text-sm break-words text-danger">{row.error}</p>
                </div>
              ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy} onClick={onRetryFailed}>
              Retry failed models
            </PrimaryButton>
            <Link
              to="/settings"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-sm border border-line bg-transparent px-3.5 py-2.5 font-semibold text-fg no-underline"
            >
              Replace failed models
            </Link>
            <GhostButton type="button" onClick={onRestart}>
              Restart Council
            </GhostButton>
          </div>
          {confirmRestart ? (
            <p className="mt-3 mb-0 rounded-md bg-subtle px-3 py-3 text-sm text-muted">
              Restart starts a new Council run and may incur new API cost.{" "}
              <button type="button" className="font-semibold text-fg underline" onClick={onRestart}>
                Confirm restart
              </button>
              {" · "}
              <button type="button" className="text-muted underline" onClick={() => setConfirmRestart(false)}>
                Keep this result
              </button>
            </p>
          ) : null}
        </Panel>
      ) : null}

      {artifact ? <ArtifactPanel artifact={artifact} /> : null}
      {packet ? <ImplementationPacketPanel packet={packet} /> : null}

      {result ? (
        <Panel>
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Council synthesis</p>
          <h2 className="font-display mb-3 text-2xl">
            <StatusPill status={displayVerdict(result.reviewVerdict, result.finalEnforcedStatus ?? result.status)} />
          </h2>
          {result.reviewVerdict ? (
            <p className="m-0 mb-3 text-sm text-muted">
              Review verdict <span className="text-fg">{result.reviewVerdict}</span>
            </p>
          ) : null}
          {result.failedAgents.length ? (
            <p className="rounded-md bg-subtle p-3 text-warn">
              Surviving reviewers continued after {result.failedAgents.join(", ")} failed.
            </p>
          ) : null}
          {result.verdictOverride ? (
            <p className="rounded-md bg-subtle p-3 text-danger">
              Final status was adjusted by the safety gate. Proposed: {result.synthesizerProposedStatus}.{" "}
              {result.overrideReason}
            </p>
          ) : null}
          {result.decision ? (
            <>
              <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Decision</h3>
              <CollapsibleText text={result.decision} />
              {result.rationale ? (
                <>
                  <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Rationale</h3>
                  <CollapsibleText text={result.rationale} />
                </>
              ) : null}
              <ListBlock title="Alternatives" rows={result.alternatives} />
              <ListBlock title="Dissent" rows={result.dissent} />
              <ListBlock title="Risks" rows={result.risks} />
            </>
          ) : null}
          <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Main recommendation</h3>
          <CollapsibleText text={result.recommendation || "—"} />
          <ListBlock title="Blockers" rows={result.blockers} />
          <ListBlock title="Disagreements" rows={result.disagreements} />
          <ListBlock title="Issues" rows={result.issues} />
          <ListBlock title="Proposed corrections" rows={result.proposedCorrections} />
          <ListBlock title="Resolved issues" rows={result.resolvedIssues} />
          <ListBlock title="Unresolved issues" rows={result.unresolvedIssues} />
          <ListBlock title="Citations" rows={result.citations} />
          {result.evidence.length ? (
            <>
              <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Evidence</h3>
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
            <CouncilFold title="Model positions" summary={agentList.map(([, label]) => label).join(" · ") || "selected models"}>
              <dl className="m-0 grid gap-3">
                {agentList.map(([key, label]) => (
                  <div key={key}>
                    <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
                    <dd className="m-0">
                      <CollapsibleText
                        text={positionForMember(result.agentPositions, key, members)}
                        defaultCollapsed
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </CouncilFold>
          </div>
          {responses[0]?.contextHash ? (
            <p className="mt-3 mb-0 text-xs break-all text-faint">
              Context hash {responses[0].contextHash}
              {hashMatch ? " · all agent responses share this snapshot" : " · snapshot mismatch"}
            </p>
          ) : null}
        </Panel>
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
            <CouncilFold key={key} title={heading} summary={recorded ? "recorded" : "not run yet"}>
              <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">Round 1</h3>
              {r1 ? (
                r1.error ? (
                  <p className="text-danger">{r1.error}</p>
                ) : (
                  <CollapsibleText text={r1.responseText} defaultCollapsed />
                )
              ) : (
                <p className="text-muted">Not run yet.</p>
              )}
              <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Round 2</h3>
              {r2 ? (
                r2.error ? (
                  <p className="text-danger">{r2.error}</p>
                ) : (
                  <CollapsibleText text={r2.responseText} defaultCollapsed />
                )
              ) : (
                <p className="text-muted">Not run yet.</p>
              )}
            </CouncilFold>
          );
        })}

        <CouncilFold
          title="Raw synthesis"
          summary={synth?.responseText || result?.synthesisRaw ? "recorded" : "not available"}
        >
          {synth?.responseText || result?.synthesisRaw ? (
            <CollapsibleText text={synth?.responseText || result?.synthesisRaw || ""} defaultCollapsed />
          ) : (
            <p className="m-0 text-muted">Not available.</p>
          )}
        </CouncilFold>

        <CouncilFold
          title="Technical metadata"
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
