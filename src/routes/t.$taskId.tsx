import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ArtifactPanel, ContextManifestPanel } from "@/components/context-manifest-panel";
import { CouncilFold } from "@/components/council-fold";
import { CouncilRunPanel } from "@/components/council-run-panel";
import { CollapsibleText } from "@/components/collapsible-text";
import { Crumb, DangerButton, GhostButton, Page, PageHeader, Panel, StatusPill } from "@/components/council-ui";
import { ImplementationPacketPanel } from "@/components/implementation-packet-panel";
import { OpLogPanel } from "@/components/op-log";
import { displayVerdict } from "@/lib/council/evaluate";
import { runCouncil, isStaleDisconnectError, runCredsFromReady } from "@/lib/council/orchestrate";
import { providerName } from "@/lib/council/providers";
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
import { beginCouncilRun, releaseCouncilRun, stopCouncilRun, type CouncilRunSnapshot } from "@/lib/council/run-control";
import { councilPreflight } from "@/lib/council/task-mode";
import { useSession } from "@/lib/council/session";
import type { AgentKey, AgentProgress } from "@/lib/council/types";
import type { EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { selectedChatsToContext } from "@/lib/history/provenance";
import { formatCouncilOpLog, formatExceptionLog, formatOpLog } from "@/lib/op-log";

export const Route = createFileRoute("/t/$taskId")({ component: TaskPage });

const AGENTS: Array<[AgentKey, string]> = [
  ["GPT", "GPT analysis"],
  ["GROK", "Grok analysis"],
  ["CLAUDE", "Claude analysis"],
];

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

function TaskPage() {
  const { taskId } = Route.useParams();
  const store = useStore();
  const { config, creds } = useSession();
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

  useEffect(() => {
    if (!config.ready) return;
    if (isStaleDisconnectError(msg, true)) setMsg("");
    if (task && isStaleDisconnectError(task.error ?? "", true)) {
      patchTask(task.id, { error: null });
    }
  }, [config.ready, msg, task?.id, task?.error]);

  if (!task || !project) {
    return (
      <Page>
        <p className="text-danger">Task not found.</p>
      </Page>
    );
  }

  const currentTask = task;
  const currentProject = project;
  const projectArtifacts = store.artifacts.filter((row) => row.projectId === project.id);
  const currentContext = [
    ...context,
    ...selectedChatsToContext(task.projectId, task.selectedChatSourceIds, store.chatSources, store.historyMessages),
  ];
  const isRunning = busy || RUNNING.has(task.status);
  const parentPacket =
    currentTask.mode === "CREATE"
      ? store.packets.filter((row) => row.projectId === currentProject.id && row.status === "READY").at(-1) ?? null
      : store.packets.find((row) => row.reviewTaskId === currentTask.id) ?? null;
  const currentRunId = task.diagnostics?.run?.runId ?? activeRunId;
  const responses = currentRunId ? allResponses.filter((row) => !row.runId || row.runId === currentRunId) : allResponses;
  const priorResponses = currentRunId ? allResponses.filter((row) => row.runId && row.runId !== currentRunId) : [];
  const persistedStage = task.diagnostics?.run?.stage ?? stage;
  const persistedAgents = task.diagnostics?.run?.agents ?? agentState;

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

  async function onRun(prepared?: EvidencePipelineResult, opts?: { force?: boolean }) {
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
    const runCreds = creds ?? runCredsFromReady(config);
    if (!runCreds) {
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
    const handle = beginCouncilRun(currentTask.id);
    runGen.current = handle.generation;
    setBusy(true);
    setConfirmRestart(false);
    setActiveRunId(handle.runId);
    setMsg("Preparing the evidence packet…");
    setStage("PREPARING");
    setAgentState({
      GPT: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
      GROK: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
      CLAUDE: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
    });
    const startedAt = new Date().toISOString();
    rememberCouncilProgress(currentTask.id, {
      runId: handle.runId,
      generation: handle.generation,
      stage: "PREPARING",
      status: "PREPARING",
      startedAt,
      stageStartedAt: startedAt,
      updatedAt: startedAt,
      agents: {
        GPT: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
        GROK: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
        CLAUDE: { state: "WAITING", attempt: 0, maxAttempts: 3, error: null },
      },
      message: "Preparing the evidence packet…",
    });
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    try {
      const out = await runCouncil({
        creds: runCreds,
        project: currentProject,
        context: currentContext,
        task: currentTask,
        chatSources: store.chatSources,
        historyMessages: store.historyMessages,
        artifacts: projectArtifacts,
        projectFiles: store.projectFiles,
        parentPacket,
        pipeline: prepared,
        runId: handle.runId,
        generation: handle.generation,
        signal: handle.signal,
        onProgress: (progress) => {
          applyProgress(handle.runId, progress);
        },
      });
      const live = getStoreSnapshot().tasks.find((row) => row.id === currentTask.id);
      if (live?.diagnostics?.run?.runId && live.diagnostics.run.runId !== handle.runId) return;
      applyCouncilOutput(currentTask.id, out);
      setMsg(out.task.error ?? "");
      setStage(out.task.status === "CANCELLED" ? "CANCELLED" : out.task.status === "COMPLETE" ? "COMPLETE" : stage);
      setLog(
        formatCouncilOpLog({
          provider: config.provider,
          task: out.task,
          responses: out.responses,
          result: out.result,
        }),
      );
    } catch (err) {
      const live = getStoreSnapshot().tasks.find((row) => row.id === currentTask.id);
      if (live?.diagnostics?.run?.runId && live.diagnostics.run.runId !== handle.runId) return;
      const text =
        err instanceof Error
          ? err.message
          : "Council stopped during request: provider error.";
      if (handle.signal.aborted) {
        markTaskCancelled(currentTask.id, "Council run stopped.");
        setMsg("Council run stopped.");
        setStage("CANCELLED");
      } else {
        markTaskFailed(currentTask.id, text);
        setMsg(text);
      }
      setLog(
        formatExceptionLog("council_run", err, {
          provider: config.provider,
          taskId: currentTask.id,
          taskTitle: currentTask.title,
        }),
      );
    } finally {
      releaseCouncilRun(currentTask.id, handle.runId);
      if (runGen.current === handle.generation) setBusy(false);
    }
  }

  function onStop() {
    const stopped = stopCouncilRun(currentTask.id, activeRunId || undefined);
    if (!stopped && !busy) {
      markTaskCancelled(currentTask.id, "Council run stopped.");
      setMsg("Council run stopped.");
      setStage("CANCELLED");
      setBusy(false);
    }
  }

  function onRestart() {
    if (!confirmRestart) {
      setConfirmRestart(true);
      return;
    }
    stopCouncilRun(currentTask.id);
    setConfirmRestart(false);
    void onRun(undefined, { force: true });
  }

  const synth = responses.find((r) => r.round === 3);
  const canRun = STARTABLE.has(task.status);
  const hashMatch = responses.length === 0 || responses.every((row) => row.contextHash === responses[0]?.contextHash);

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
          providerLabel={providerName(config.provider)}
          busy={busy}
          message={isStaleDisconnectError(msg, config.ready) ? "" : msg}
          onRun={(prepared) => void onRun(prepared)}
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
          <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">In progress</p>
          <h2 className="font-display mb-2 text-xl">Council is running</h2>
          <p className="text-muted">{msg || task.diagnostics?.run?.message || "Preparing…"}</p>
          <p className="mt-3 mb-1 text-xs font-semibold tracking-widest text-muted uppercase">{persistedStage}</p>
          <p className="m-0 mb-3 text-xs text-faint">
            Stage started {task.diagnostics?.run?.stageStartedAt ?? "just now"}
            {task.diagnostics?.run?.updatedAt ? ` · updated ${task.diagnostics.run.updatedAt}` : ""}
          </p>
          <ul className="m-0 grid list-none gap-2 p-0 sm:grid-cols-3">
            {AGENTS.map(([agent]) => {
              const row = persistedAgents[agent] ?? agentState[agent];
              const state = row?.state ?? "WAITING";
              return (
                <li key={agent} className="rounded-md bg-subtle px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-fg">{agent}</strong>
                    <StatusPill status={state} />
                  </div>
                  <p className="m-0 mt-1 text-xs text-faint">
                    {state === "RUNNING" && row
                      ? `attempt ${row.attempt}/${row.maxAttempts}`
                      : state === "FAILED" && row?.error
                        ? row.error
                        : state.toLowerCase()}
                  </p>
                </li>
              );
            })}
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
            <CouncilFold title="Model positions" summary="GPT · Grok · Claude">
              <dl className="m-0 grid gap-3">
                <div>
                  <dt className="text-xs tracking-wider text-faint uppercase">GPT</dt>
                  <dd className="m-0">
                    <CollapsibleText text={result.agentPositions.gpt || "—"} defaultCollapsed />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs tracking-wider text-faint uppercase">Grok</dt>
                  <dd className="m-0">
                    <CollapsibleText text={result.agentPositions.grok || "—"} defaultCollapsed />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs tracking-wider text-faint uppercase">Claude</dt>
                  <dd className="m-0">
                    <CollapsibleText text={result.agentPositions.claude || "—"} defaultCollapsed />
                  </dd>
                </div>
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
        {AGENTS.map(([key, heading]) => {
          const r1 = responses.find((r) => r.agent === key && r.round === 1);
          const r2 = responses.find((r) => r.agent === key && r.round === 2);
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
            <span>Council cost: {task.totalCostUsd != null ? `$${task.totalCostUsd.toFixed(4)}` : "—"}</span>
            <span>Input tokens: {task.totalInputTokens ?? "—"}</span>
            <span>Output tokens: {task.totalOutputTokens ?? "—"}</span>
            <span>Total latency: {task.totalLatencyMs != null ? `${task.totalLatencyMs} ms` : "—"}</span>
          </p>
          <pre className="mt-0 max-h-log overflow-auto font-mono text-sm whitespace-pre-wrap break-all text-muted tabular-nums">
            {responses
              .map(
                (row) =>
                  `${row.agent} r${row.round} · ${row.model} · in=${row.inputTokens} out=${row.outputTokens} cost=${row.cost} latency=${row.latencyMs} hash=${row.contextHash ?? "—"}`,
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
                  `${row.runId?.slice(0, 8) ?? "legacy"} · ${row.agent} r${row.round} · ${row.error ? "failed" : "kept"}`,
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
