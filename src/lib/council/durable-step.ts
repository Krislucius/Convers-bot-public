import { nextArtifactStatus, normalizeEvidenceLabels } from "./artifact.ts";
import { persistableManifest } from "./manifest.ts";
import {
  AGENT_MAX,
  applyGate,
  cancelledOutput,
  chat,
  completeOutput,
  failedOutput,
  modelFor,
  parseJson,
  precheckOutput,
  responseFromCompletion,
  responseFromError,
  ROUND2,
  rolesForMode,
  synthesisForMode,
} from "./protocol.ts";
import { councilPreflight } from "./task-mode.ts";
import { CONTEXT_BUDGET_EXCEEDED, coverageBlocksCouncil } from "../evidence/pipeline.ts";
import { cachedEvidencePipeline } from "../evidence/pipeline-cache.ts";
import {
  councilPartial,
  failedResponses,
  responseMemberId,
  survivingResponses,
  synthesizerQueue,
} from "./agents.ts";
import { sanitizeEvidenceLabels } from "./citations.ts";
import { buildImplementationPacket } from "./packet.ts";
import { artifactStatusForReview, reviewVerdictFromStatus } from "./review.ts";
import {
  PROVIDER_ATTEMPTS,
  formatProviderFailure,
  isRetryableFailure,
  providerFailure,
  toProviderFailure,
  type ProviderFailure,
} from "./provider-error.ts";
import { CouncilCancelled, isCancelledSignal, type CouncilStageName } from "./run-control.ts";
import { createRequestCounter, emptyRequestBudget, isEmptyCompletion } from "./request-budget.ts";
import { MODEL_UNAVAILABLE } from "./catalog.ts";
import { sameProviderScan } from "./provider-adapter.ts";
import { ensureMembers, findMember, type CouncilMember } from "./members.ts";
import { assertRunCredentials, type CouncilRuntime } from "./orchestrate.ts";
import {
  hydrateCursor,
  isTerminalStatus,
  taskStatusFor,
  waitingAgents,
  completedKey,
  type DurableRunRow,
  type DurableStage,
  type DurableStatus,
} from "./durable-run.ts";
import {
  TEST_PACING,
  retryWaitMs,
  sleep,
  stallAfterIdle,
} from "./pacing.ts";
import {
  accessFromProbe,
  evaluatePreflightGate,
  interpretAccessForModel,
  modelProbeCallable,
  nextPreflightStep,
  parseSubscriptionUsage,
  patchPreflightStep,
  seedPreflight,
  subscriptionBlocksRun,
} from "./start-preflight.ts";
import { outcomeFromFailure, recordHealth } from "./model-health.ts";
import { hasPersistedSynthesis, synthesisIsReconcilable } from "./terminal.ts";
import type {
  AgentKey,
  AgentProgress,
  AgentResponse,
  Artifact,
  CouncilCallStage,
  ImplementationPacket,
  Task,
} from "./types.ts";

export type DurableStepResult = {
  row: DurableRunRow;
  didProviderCall: boolean;
  terminal: boolean;
  skipped?: boolean;
};

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function tagRun(row: AgentResponse, runId: string): AgentResponse {
  return {
    ...row,
    runId,
    structured: { ...(row.structured ?? {}), __runId: runId },
  };
}

function snapshotStage(stage: CouncilCallStage): CouncilStageName {
  if (stage === "SYNTHESIS") return "SYNTHESIS";
  if (stage === "ROUND_2") return "ROUND_2";
  return "ROUND_1";
}

function patchSnapshot(
  row: DurableRunRow,
  extras: {
    status: DurableStatus;
    stage: DurableStage;
    message: string;
    now: string;
    agents?: Partial<Record<AgentKey, AgentProgress>>;
    requestUsed?: number;
  },
): void {
  const stageChanged = row.snapshot.stage !== extras.stage && extras.stage !== "QUEUED";
  row.status = extras.status;
  row.stage = extras.stage === "QUEUED" ? "PREPARING" : extras.stage;
  row.lastProgressAt = extras.now;
  row.error = extras.status === "FAILED" || extras.status === "CANCELLED" ? extras.message : null;
  if (extras.agents) row.snapshot.agents = extras.agents;
  const budget = emptyRequestBudget(row.members.length || 3);
  row.snapshot = {
    ...row.snapshot,
    generation: row.generation,
    stage: row.stage as CouncilStageName,
    status: taskStatusFor(row.status, row.stage),
    updatedAt: extras.now,
    stageStartedAt: stageChanged ? extras.now : row.snapshot.stageStartedAt,
    message: extras.message,
    agents: extras.agents ?? row.snapshot.agents,
    requestBudget: {
      ...budget,
      ...(row.snapshot.requestBudget ?? {}),
      used: extras.requestUsed ?? row.cursor.requestUsed,
      preflightCalls: row.cursor.preflightCalls,
      councilCalls: row.cursor.councilCalls,
      retries: row.cursor.retries,
    },
    costUsd: row.cursor.spent,
    inputTokens: row.cursor.tokenIn || null,
    outputTokens: row.cursor.tokenOut || null,
    latencyMs: row.cursor.latencyMs || null,
    currentMemberId: row.cursor.currentMemberId,
    currentModelId: row.cursor.currentModelId,
    currentRequestStartedAt: row.cursor.currentRequestStartedAt,
    lastProviderResponseAt: row.cursor.lastProviderResponseAt,
    lastProviderHttpStatus: row.cursor.lastProviderHttpStatus,
    lastProgressAt: extras.now,
    internalStage: row.cursor.internalStage,
    stallReason: row.cursor.stallReason,
    preflight: row.cursor.preflight,
    modelHealth: row.cursor.modelHealth,
  };
}

function failRow(row: DurableRunRow, message: string, stage: DurableStage, now: string, partial = false): DurableRunRow {
  const out = failedOutput(row.frozenInput.task, row.responses, message, { manifest: row.cursor.manifest });
  if (partial) {
    row.snapshot.partial = true;
    row.snapshot.synthesisSkipped = message;
  }
  row.output = out;
  row.completedAt = now;
  row.cursor.phase = "FAILED";
  patchSnapshot(row, { status: "FAILED", stage, message, now, requestUsed: row.cursor.requestUsed });
  return row;
}

function cancelRow(row: DurableRunRow, now: string, message = "Council run stopped."): DurableRunRow {
  if (row.status === "COMPLETE" || row.status === "FAILED") return row;
  if (hasPersistedSynthesis(row) || synthesisIsReconcilable(row.responses, row.frozenInput.task.mode)) {
    return finalize(row, now);
  }
  const agents = { ...(row.snapshot.agents ?? {}) };
  for (const member of row.members) {
    const current = agents[member.memberId];
    if (current?.state === "WAITING" || current?.state === "RUNNING") {
      agents[member.memberId] = { ...current, state: "FAILED", error: message };
    }
  }
  row.output = cancelledOutput(row.frozenInput.task, row.responses, { manifest: row.cursor.manifest, message });
  row.completedAt = now;
  row.cancelRequested = true;
  row.cursor.phase = "CANCELLED";
  row.cursor.stallReason = null;
  patchSnapshot(row, { status: "CANCELLED", stage: "CANCELLED", message, now, agents });
  return row;
}

async function askMember(opts: {
  row: DurableRunRow;
  member: CouncilMember;
  callStage: CouncilCallStage;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  runtime: CouncilRuntime;
  signal?: AbortSignal;
  now: () => string;
  responseFormat?: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<AgentResponse> {
  const { row, member, callStage, system, user, maxTokens, temperature, runtime, signal } = opts;
  const runId = row.runId;
  const runProvider = row.provider;
  const runBilling = row.nanogptBilling ?? undefined;
  const models = modelFor({
    provider: runProvider,
    apiKey: "",
    members: row.members,
    synthesizerModel: row.synthesizerModel,
    maxCostUsd: row.frozenInput.maxCostUsd,
  });
  const dispatchedModelId = member.modelId.trim();
  const mapped = models[member.memberId];
  const maxAttempts = Math.max(1, opts.maxAttempts ?? PROVIDER_ATTEMPTS);
  const agents: Partial<Record<AgentKey, AgentProgress>> = { ...(row.snapshot.agents ?? waitingAgents(row.members)) };
  const requests = createRequestCounter(row.members.length, {
    used: row.cursor.requestUsed,
    preflightCalls: row.cursor.preflightCalls,
    councilCalls: row.cursor.councilCalls,
    retries: row.cursor.retries,
  });
  const flushUsed = () => {
    const snap = requests.snapshot();
    row.cursor.requestUsed = snap.used;
    row.cursor.preflightCalls = snap.preflightCalls;
    row.cursor.councilCalls = snap.councilCalls;
    row.cursor.retries = snap.retries;
  };
  const emit = (message: string, agentState: AgentProgress) => {
    agents[member.memberId] = agentState;
    flushUsed();
    patchSnapshot(row, {
      status: callStage === "SYNTHESIS" ? "SYNTHESIS" : callStage === "ROUND_2" ? "ROUND_2" : "ROUND_1",
      stage: snapshotStage(callStage),
      message,
      now: opts.now(),
      agents,
      requestUsed: requests.used(),
    });
  };
  const errRow = (message: string, attempt: number | null) =>
    tagRun(
      responseFromError(
        row.taskId,
        member,
        callStage,
        dispatchedModelId,
        system,
        user,
        message,
        row.cursor.manifest,
        runProvider,
        attempt,
      ),
      runId,
    );
  if (mapped && mapped !== dispatchedModelId) {
    const mismatch = `DISPATCHED_MODEL_ID ${mapped} does not equal selected model ${dispatchedModelId} for ${member.memberId}.`;
    emit(mismatch, { state: "FAILED", attempt: 0, maxAttempts, error: mismatch });
    return errRow(mismatch, 0);
  }
  if (isCancelledSignal(signal) || row.cancelRequested) {
    emit("Council run stopped.", { state: "FAILED", attempt: 0, maxAttempts, error: "Council run stopped." });
    return errRow("Council run stopped.", 0);
  }
  let lastFailure: ProviderFailure | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isCancelledSignal(signal) || row.cancelRequested) {
      emit("Council run stopped.", { state: "FAILED", attempt, maxAttempts, error: "Council run stopped." });
      return errRow("Council run stopped.", attempt);
    }
    try {
      requests.consume(`${member.memberId} ${member.role} ${callStage} ${dispatchedModelId}`, attempt === 1 ? "COUNCIL" : "RETRY");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Council stopped because the request limit was reached.";
      emit(message, { state: "FAILED", attempt: Math.max(0, attempt - 1), maxAttempts, error: message });
      row.cursor.requestUsed = requests.used();
      return errRow(message, Math.max(0, attempt - 1));
    }
    emit(
      attempt > 1
        ? `${member.label} retry ${attempt}/${maxAttempts} after ${lastFailure?.errorClass ?? lastFailure?.httpClass ?? "error"}.`
        : `${member.label} is running (${attempt}/${maxAttempts}).`,
      { state: "RUNNING", attempt, maxAttempts, error: null, detail: "RUNNING" },
    );
    row.cursor.currentMemberId = member.memberId;
    row.cursor.currentModelId = dispatchedModelId;
    row.cursor.currentRequestStartedAt = opts.now();
    row.cursor.internalStage = "DISPATCH_PENDING";
    try {
      const out = await runtime.completeChat({
        provider: runProvider,
        apiKey: "",
        model: dispatchedModelId,
        messages: chat(system, user),
        maxTokens,
        temperature,
        responseFormat: opts.responseFormat,
        signal,
        nanogptBilling: runBilling,
      });
      if (!out.ok && (isCancelledSignal(signal) || row.cancelRequested || out.error === "Council run stopped.")) {
        emit("Council run stopped.", { state: "FAILED", attempt, maxAttempts, error: "Council run stopped." });
        row.cursor.requestUsed = requests.used();
        return errRow("Council run stopped.", attempt);
      }
      if (out.ok && isEmptyCompletion(out.completion.text)) {
        lastFailure = providerFailure({
          provider: runProvider,
          model: dispatchedModelId,
          stage: `${member.memberId} ${callStage}`,
          httpClass: "empty",
          errorClass: "EMPTY_RESPONSE",
          attempt,
          maxAttempts,
          raw: "empty response",
          requestId: out.completion.requestId,
        });
      } else if (out.ok) {
        if (out.completion.inputTokens != null) row.cursor.tokenIn += out.completion.inputTokens;
        if (out.completion.outputTokens != null) row.cursor.tokenOut += out.completion.outputTokens;
        if (out.completion.latencyMs != null) row.cursor.latencyMs += out.completion.latencyMs;
        if (out.completion.cost != null) row.cursor.spent = (row.cursor.spent ?? 0) + out.completion.cost;
        row.cursor.lastProviderResponseAt = opts.now();
        row.cursor.lastProviderHttpStatus = 200;
        row.cursor.modelHealth[dispatchedModelId] = recordHealth(row.cursor.modelHealth[dispatchedModelId], {
          modelId: dispatchedModelId,
          at: opts.now(),
          kind: "runtime",
          outcome: "success",
          latencyMs: out.completion.latencyMs ?? null,
          httpStatus: 200,
        });
        emit(`${member.label} finished.`, { state: "DONE", attempt, maxAttempts, error: null, detail: "DONE" });
        row.cursor.requestUsed = requests.used();
        return tagRun(
          responseFromCompletion(
            row.taskId,
            member,
            callStage,
            system,
            user,
            out.completion,
            row.cursor.manifest,
            runProvider,
            attempt,
          ),
          runId,
        );
      } else {
        lastFailure =
          out.failure ??
          toProviderFailure(out.error, { provider: runProvider, model: dispatchedModelId, stage: `${member.memberId} ${callStage}` });
        lastFailure = {
          ...lastFailure,
          attempt,
          maxAttempts,
          message: formatProviderFailure({ ...lastFailure, attempt, maxAttempts }),
        };
      }
    } catch (err) {
      if (err instanceof CouncilCancelled || isCancelledSignal(signal) || row.cancelRequested) {
        emit("Council run stopped.", { state: "FAILED", attempt, maxAttempts, error: "Council run stopped." });
        row.cursor.requestUsed = requests.used();
        return errRow("Council run stopped.", attempt);
      }
      lastFailure = toProviderFailure(err, {
        provider: runProvider,
        model: dispatchedModelId,
        stage: `${member.memberId} ${callStage}`,
      });
      lastFailure = {
        ...lastFailure,
        attempt,
        maxAttempts,
        message: formatProviderFailure({ ...lastFailure, attempt, maxAttempts }),
      };
    }
    const retryable = isRetryableFailure(lastFailure);
    if (retryable && attempt < maxAttempts) {
      if (isCancelledSignal(signal) || row.cancelRequested) {
        emit("Council run stopped.", { state: "FAILED", attempt, maxAttempts, error: "Council run stopped." });
        row.cursor.requestUsed = requests.used();
        return errRow("Council run stopped.", attempt);
      }
      await sleep(
        retryWaitMs({
          attempt,
          errorClass: lastFailure?.errorClass,
          httpClass: lastFailure?.httpClass,
          retryAfterHeader: lastFailure?.retryAfter,
          retryAfterMs: lastFailure?.retryAfterMs,
          pacing: runtime.pacing ?? TEST_PACING,
        }),
        signal,
      );
      continue;
    }
    const failure = lastFailure
      ? { ...lastFailure, attempt, maxAttempts, retryExhausted: retryable, message: "" }
      : providerFailure({
          provider: runProvider,
          model: dispatchedModelId,
          stage: `${member.memberId} ${callStage}`,
          attempt,
          maxAttempts,
          retryExhausted: retryable,
          errorClass: "PROVIDER_ERROR",
        });
    failure.message = formatProviderFailure(failure);
    emit(failure.message, { state: "FAILED", attempt, maxAttempts, error: failure.message, detail: "FAILED" });
    row.cursor.requestUsed = requests.used();
    const snap = requests.snapshot();
    row.cursor.preflightCalls = snap.preflightCalls;
    row.cursor.councilCalls = snap.councilCalls;
    row.cursor.retries = snap.retries;
    row.cursor.lastProviderResponseAt = opts.now();
    row.cursor.lastProviderHttpStatus = failure.httpStatus;
    row.cursor.modelHealth[dispatchedModelId] = recordHealth(row.cursor.modelHealth[dispatchedModelId], {
      modelId: dispatchedModelId,
      at: opts.now(),
      kind: "runtime",
      outcome: outcomeFromFailure(failure.errorClass, failure.httpClass),
      latencyMs: null,
      httpStatus: failure.httpStatus,
    });
    return errRow(failure.message, attempt);
  }
  row.cursor.requestUsed = requests.used();
  return errRow("PROVIDER_ERROR", maxAttempts);
}

function roundRows(row: DurableRunRow, stage: CouncilCallStage): AgentResponse[] {
  return row.responses.filter((item) => item.stage === stage && item.runId === row.runId);
}

function nextRound1Member(row: DurableRunRow): CouncilMember | null {
  const done = new Set(row.cursor.completedKeys);
  const callable = new Set(
    row.cursor.callableMemberIds.length
      ? row.cursor.callableMemberIds
      : row.members.map((member) => member.memberId),
  );
  return (
    row.members.find(
      (member) => callable.has(member.memberId) && !done.has(completedKey("ROUND_1", member.memberId)),
    ) ?? null
  );
}

function nextRound2Member(row: DurableRunRow): CouncilMember | null {
  const round1 = roundRows(row, "ROUND_1");
  const alive = row.members.filter((member) =>
    survivingResponses(round1).some((item) => responseMemberId(item) === member.memberId),
  );
  const done = new Set(row.cursor.completedKeys);
  return alive.find((member) => !done.has(completedKey("ROUND_2", member.memberId))) ?? null;
}

async function prepare(row: DurableRunRow, runtime: CouncilRuntime, now: () => string): Promise<DurableRunRow> {
  const frozen = row.frozenInput;
  const members = ensureMembers(frozen.members);
  const boundTask: Task = {
    ...frozen.task,
    provider: row.provider,
    selectedModels: members,
    nanogptBilling: row.nanogptBilling,
  };
  const precheck = councilPreflight({ task: boundTask, artifacts: frozen.artifacts });
  if (!precheck.ok) {
    row.output = precheckOutput(boundTask, precheck.error ?? "PRECHECK_FAIL");
    return failRow(row, precheck.error ?? "PRECHECK_FAIL", "PREPARING", now(), false);
  }
  const credsError = assertRunCredentials({
    provider: row.provider,
    apiKey: "",
    members,
    synthesizerModel: frozen.synthesizerModel,
    maxCostUsd: frozen.maxCostUsd,
    nanogptBilling: row.nanogptBilling ?? undefined,
  });
  if (credsError) {
    row.output = precheckOutput(boundTask, credsError);
    return failRow(row, credsError, "PREPARING", now(), false);
  }
  const scanMix = sameProviderScan(frozen.scan ?? null, row.provider, row.nanogptBilling ?? undefined);
  if (scanMix) {
    row.output = precheckOutput(boundTask, scanMix);
    return failRow(row, scanMix, "PREPARING", now(), false);
  }
  const candidate = boundTask.candidateArtifactId
    ? frozen.artifacts.find((item) => item.id === boundTask.candidateArtifactId) ?? null
    : null;
  const pipeline = cachedEvidencePipeline({
    project: frozen.project,
    task: boundTask,
    frozen: frozen.context.filter((item) => item.kind !== "RAW_HISTORY"),
    chatSources: frozen.chatSources,
    historyMessages: frozen.historyMessages,
    projectFiles: frozen.projectFiles.filter((file) => (boundTask.selectedFileIds ?? []).includes(file.id)),
    candidateText: candidate ? `# ${candidate.title} v${candidate.version}\n\n${candidate.content}` : null,
  });
  const coverageError = coverageBlocksCouncil(pipeline.coverage);
  if (coverageError) {
    row.output = precheckOutput(boundTask, coverageError);
    return failRow(row, coverageError, "PREPARING", now(), false);
  }
  if (!pipeline.pack.ok) {
    row.output = precheckOutput(boundTask, CONTEXT_BUDGET_EXCEEDED);
    return failRow(row, CONTEXT_BUDGET_EXCEEDED, "PREPARING", now(), false);
  }
  row.cursor.packedText = pipeline.pack.text;
  row.cursor.manifest = persistableManifest({
    project: { id: frozen.project.id, name: frozen.project.name, description: frozen.project.description, createdAt: "" },
    task: boundTask,
    context: frozen.context,
    chatSources: frozen.chatSources,
    historyMessages: frozen.historyMessages,
    artifacts: frozen.artifacts,
    projectFiles: frozen.projectFiles,
    contextText: pipeline.pack.text,
    evidence: pipeline.manifest,
  });
  row.cursor.contextHash = row.cursor.manifest.hash;
  row.contextHash = row.cursor.manifest.hash;

  const resumeKept = (frozen.resumeResponses ?? [])
    .filter((item) => item.round === 1 && !item.error)
    .map((item) => {
      const member = findMember(members, item);
      const memberId = member?.memberId ?? responseMemberId(item);
      return tagRun(
        {
          ...item,
          runId: row.runId,
          memberId,
          agent: memberId,
          role: member?.role ?? item.role,
          dispatchedModelId: item.dispatchedModelId || member?.modelId || item.model,
          stage: item.stage || "ROUND_1",
        },
        row.runId,
      );
    });
  const agents = waitingAgents(members);
  for (const item of resumeKept) {
    agents[responseMemberId(item)] = { state: "DONE", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null, detail: "DONE" };
    row.cursor.completedKeys.push(completedKey("ROUND_1", responseMemberId(item)));
  }
  row.responses.push(...resumeKept);
  row.snapshot.agents = agents;
  row.cursor.preflight = seedPreflight({
    members,
    provider: row.provider,
    nanogptBilling: row.nanogptBilling,
  });
  row.cursor.catalogOk = false;
  row.cursor.accessOk = false;
  row.cursor.internalStage = "PREFLIGHT";
  row.cursor.phase = "PREPARING";
  patchSnapshot(row, {
    status: "PREPARING",
    stage: "PREPARING",
    message: "PRECHECK — starting live provider preflight.",
    now: now(),
    agents,
  });
  return row;
}

function consumePreflight(row: DurableRunRow, stage: string): string | null {
  const requests = createRequestCounter(row.members.length, {
    used: row.cursor.requestUsed,
    preflightCalls: row.cursor.preflightCalls,
    councilCalls: row.cursor.councilCalls,
    retries: row.cursor.retries,
  });
  try {
    requests.consume(stage, "PREFLIGHT");
  } catch (err) {
    return err instanceof Error ? err.message : "Council stopped because the request limit was reached.";
  }
  const snap = requests.snapshot();
  row.cursor.requestUsed = snap.used;
  row.cursor.preflightCalls = snap.preflightCalls;
  row.cursor.councilCalls = snap.councilCalls;
  row.cursor.retries = snap.retries;
  return null;
}

async function advancePreflight(
  row: DurableRunRow,
  runtime: CouncilRuntime,
  now: () => string,
  signal?: AbortSignal,
): Promise<DurableRunRow> {
  const members = ensureMembers(row.members);
  const boundTask: Task = {
    ...row.frozenInput.task,
    provider: row.provider,
    selectedModels: members,
    nanogptBilling: row.nanogptBilling,
  };
  if (!row.cursor.preflight) {
    row.cursor.preflight = seedPreflight({
      members,
      provider: row.provider,
      nanogptBilling: row.nanogptBilling,
    });
  }
  const selectedIds = members.map((item) => item.modelId);
  const catalogFn =
    runtime.catalogCheck ??
    (async () => ({ ok: true as const, missing: [] as string[], available: selectedIds }));
  const accessFn =
    runtime.accessCheck ??
    (async () => ({ ok: true, blocked: [] as Array<{ id: string; access: string }> }));
  const agents = { ...(row.snapshot.agents ?? waitingAgents(members)) };
  const pending = nextPreflightStep(row.cursor.preflight);
  if (!pending) {
    const gateResult = evaluatePreflightGate(row.cursor.preflight);
    if (!gateResult.ok) {
      row.cursor.internalStage = "FAILED";
      if (row.responses.length) return failRow(row, gateResult.error ?? "PREFLIGHT failed", "PREPARING", now(), true);
      row.output = precheckOutput(boundTask, gateResult.error ?? "PREFLIGHT failed");
      return failRow(row, gateResult.error ?? "PREFLIGHT failed", "PREPARING", now(), false);
    }
    row.cursor.catalogOk = true;
    row.cursor.accessOk = true;
    row.cursor.callableMemberIds = gateResult.callable;
    row.cursor.phase = "ROUND_1";
    row.cursor.internalStage = "DISPATCH_PENDING";
    row.cursor.currentMemberId = members.find((item) => gateResult.callable.includes(item.memberId))?.memberId ?? null;
    row.cursor.currentModelId =
      members.find((item) => item.memberId === row.cursor.currentMemberId)?.modelId ?? null;
    for (const member of members) {
      if (gateResult.callable.includes(member.memberId) || agents[member.memberId]?.state === "DONE") {
        if (agents[member.memberId]?.state !== "DONE") {
          agents[member.memberId] = {
            state: "WAITING",
            attempt: 0,
            maxAttempts: PROVIDER_ATTEMPTS,
            error: null,
            detail: "VERIFIED",
          };
        }
      } else {
        agents[member.memberId] = {
          state: "FAILED",
          attempt: agents[member.memberId]?.attempt ?? 0,
          maxAttempts: PROVIDER_ATTEMPTS,
          error: agents[member.memberId]?.error ?? "Not callable after preflight.",
          detail: "FAILED",
        };
        const key = completedKey("ROUND_1", member.memberId);
        if (!row.cursor.completedKeys.includes(key)) row.cursor.completedKeys.push(key);
      }
    }
    patchSnapshot(row, {
      status: "ROUND_1",
      stage: "ROUND_1",
      message: `PRECHECK PASS — ${gateResult.callable.length} models callable. Dispatching sequentially.`,
      now: now(),
      agents,
    });
    return row;
  }

  row.cursor.internalStage = "PREFLIGHT";
  row.cursor.preflight = patchPreflightStep(row.cursor.preflight, { ...pending, status: "RUNNING" });
  if (pending.memberId) {
    row.cursor.currentMemberId = pending.memberId;
    row.cursor.currentModelId = pending.modelId ?? null;
    agents[pending.memberId] = {
      state: "RUNNING",
      attempt: 0,
      maxAttempts: PROVIDER_ATTEMPTS,
      error: null,
      detail: "PROBING",
    };
  }
  patchSnapshot(row, {
    status: "PREPARING",
    stage: "PREPARING",
    message: `PRECHECK — ${pending.label}`,
    now: now(),
    agents,
  });

  if (pending.kind === "PROVIDER") {
    row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
      ...pending,
      status: "PASS",
      latencyMs: 0,
      error: null,
      httpStatus: null,
    });
    patchSnapshot(row, {
      status: "PREPARING",
      stage: "PREPARING",
      message: "PRECHECK — PROVIDER PASS",
      now: now(),
      agents,
    });
    return row;
  }

  if (pending.kind === "SUBSCRIPTION") {
    if (!runtime.subscriptionCheck) {
      row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
        ...pending,
        status: "SKIPPED",
        error: "Subscription usage not required for this provider.",
      });
      patchSnapshot(row, {
        status: "PREPARING",
        stage: "PREPARING",
        message: "PRECHECK — SUBSCRIPTION SKIPPED",
        now: now(),
        agents,
      });
      return row;
    }
    const limit = consumePreflight(row, "preflight subscription");
    if (limit) return failRow(row, limit, "PREPARING", now(), false);
    row.cursor.currentRequestStartedAt = now();
    const usage = await runtime.subscriptionCheck({
      provider: row.provider,
      apiKey: "",
      nanogptBilling: row.nanogptBilling ?? undefined,
    });
    row.cursor.lastProviderResponseAt = now();
    row.cursor.lastProviderHttpStatus = usage.status;
    const parsed = parseSubscriptionUsage(null, usage.status);
    const block = usage.skipped
      ? null
      : usage.ok
        ? subscriptionBlocksRun(parsed, usage.status)
        : usage.error || "SUBSCRIPTION check failed.";
    row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
      ...pending,
      status: usage.skipped ? "SKIPPED" : block ? "FAILED" : "PASS",
      latencyMs: usage.latencyMs,
      error: block,
      httpStatus: usage.status,
    });
    if (block) {
      row.output = precheckOutput(boundTask, block);
      return failRow(row, block, "PREPARING", now(), false);
    }
    patchSnapshot(row, {
      status: "PREPARING",
      stage: "PREPARING",
      message: usage.skipped ? "PRECHECK — SUBSCRIPTION SKIPPED" : "PRECHECK — SUBSCRIPTION PASS",
      now: now(),
      agents,
    });
    return row;
  }

  if (pending.kind === "CATALOG") {
    const limit = consumePreflight(row, "preflight catalog");
    if (limit) return failRow(row, limit, "PREPARING", now(), false);
    row.cursor.currentRequestStartedAt = now();
    const catalog = await catalogFn({
      provider: row.provider,
      apiKey: "",
      models: selectedIds,
      nanogptBilling: row.nanogptBilling ?? undefined,
    });
    row.cursor.lastProviderResponseAt = now();
    if (!catalog.ok) {
      const error = catalog.error ?? MODEL_UNAVAILABLE;
      row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
        ...pending,
        status: "FAILED",
        error,
      });
      row.output = precheckOutput(boundTask, error);
      return failRow(row, error, "PREPARING", now(), false);
    }
    row.cursor.catalogOk = true;
    row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
      ...pending,
      status: "PASS",
      latencyMs: 0,
      httpStatus: 200,
    });
    for (const id of catalog.missing ?? []) {
      const member = members.find((item) => item.modelId === id);
      if (!member) continue;
      const modelStep = row.cursor.preflight.steps.find((step) => step.memberId === member.memberId);
      if (!modelStep || modelStep.status !== "WAITING") continue;
      row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
        ...modelStep,
        status: "FAILED",
        access: "UNAVAILABLE",
        error: `${MODEL_UNAVAILABLE}: ${id} is not in the live catalog.`,
        httpStatus: 404,
      });
    }
    patchSnapshot(row, {
      status: "PREPARING",
      stage: "PREPARING",
      message: "PRECHECK — CATALOG PASS",
      now: now(),
      agents,
    });
    return row;
  }

  const member = members.find((item) => item.memberId === pending.memberId);
  if (!member) {
    row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
      ...pending,
      status: "FAILED",
      error: "Unknown member.",
    });
    return row;
  }
  const limit = consumePreflight(row, `preflight probe ${member.modelId}`);
  if (limit) return failRow(row, limit, "PREPARING", now(), false);
  row.cursor.currentMemberId = member.memberId;
  row.cursor.currentModelId = member.modelId;
  row.cursor.currentRequestStartedAt = now();
  const started = Date.now();
  let status = 200;
  let error: string | null = null;
  let body = "";
  let latency = 0;
  let requestId: string | null = null;
  if (runtime.probeModel) {
    const probe = await runtime.probeModel({
      provider: row.provider,
      apiKey: "",
      model: member.modelId,
      nanogptBilling: row.nanogptBilling ?? undefined,
    });
    status = probe.status;
    error = probe.error ?? null;
    body = probe.body ?? "";
    latency = probe.latencyMs;
    requestId = probe.headers?.["x-request-id"] ?? null;
  } else {
    const access = await accessFn({
      provider: row.provider,
      apiKey: "",
      models: [member.modelId],
      nanogptBilling: row.nanogptBilling ?? undefined,
    });
    const interpreted = interpretAccessForModel(member.modelId, access);
    status = interpreted.access === "VERIFIED_AVAILABLE" ? 200 : 403;
    error = interpreted.error;
    latency = Date.now() - started;
    const callable = modelProbeCallable(interpreted.access);
    row.cursor.lastProviderResponseAt = now();
    row.cursor.lastProviderHttpStatus = status;
    row.cursor.modelHealth[member.modelId] = recordHealth(row.cursor.modelHealth[member.modelId], {
      modelId: member.modelId,
      at: now(),
      kind: "probe",
      outcome: callable ? "success" : "failure",
      latencyMs: latency,
      httpStatus: status,
    });
    agents[member.memberId] = {
      state: callable ? "WAITING" : "FAILED",
      attempt: 0,
      maxAttempts: PROVIDER_ATTEMPTS,
      error: callable ? null : error,
      detail: callable ? "VERIFIED" : "FAILED",
      latencyMs: latency,
      httpStatus: status,
    };
    row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
      ...pending,
      status: callable ? "PASS" : "FAILED",
      access: interpreted.access,
      latencyMs: latency,
      error: callable ? null : error || `${member.modelId} ${interpreted.access}`,
      httpStatus: status,
    });
    patchSnapshot(row, {
      status: "PREPARING",
      stage: "PREPARING",
      message: callable
        ? `PRECHECK — ${member.label} VERIFIED ${latency}ms`
        : `PRECHECK — ${member.label} FAILED ${interpreted.access}`,
      now: now(),
      agents,
    });
    return row;
  }
  row.cursor.lastProviderResponseAt = now();
  row.cursor.lastProviderHttpStatus = status;
  const access = accessFromProbe({ status, error, body, inCatalog: true });
  const callable = modelProbeCallable(access);
  row.cursor.modelHealth[member.modelId] = recordHealth(row.cursor.modelHealth[member.modelId], {
    modelId: member.modelId,
    at: now(),
    kind: "probe",
    outcome: callable ? "success" : status === 429 ? "rate_limited" : status === 0 ? "timeout" : "failure",
    latencyMs: latency,
    httpStatus: status,
  });
  agents[member.memberId] = {
    state: callable ? "WAITING" : "FAILED",
    attempt: 0,
    maxAttempts: PROVIDER_ATTEMPTS,
    error: callable ? null : error,
    detail: callable ? "VERIFIED" : "FAILED",
    latencyMs: latency,
    httpStatus: status,
  };
  row.cursor.preflight = patchPreflightStep(row.cursor.preflight, {
    ...pending,
    status: callable ? "PASS" : "FAILED",
    access,
    latencyMs: latency,
    error: callable ? null : error || `${member.modelId} ${access}`,
    httpStatus: status,
    requestId,
  });
  patchSnapshot(row, {
    status: "PREPARING",
    stage: "PREPARING",
    message: callable
      ? `PRECHECK — ${member.label} VERIFIED ${latency}ms`
      : `PRECHECK — ${member.label} FAILED ${access}`,
    now: now(),
    agents,
  });
  void signal;
  return row;
}

function finalize(row: DurableRunRow, now: string): DurableRunRow {
  const frozen = row.frozenInput;
  const mode = frozen.task.mode;
  const round1 = roundRows(row, "ROUND_1");
  const round2 = roundRows(row, "ROUND_2");
  const synthRows = roundRows(row, "SYNTHESIS").filter((item) => !item.error);
  const synth = synthRows.at(-1) ?? null;
  if (!synth) {
    const attempts = roundRows(row, "SYNTHESIS");
    const details = attempts.map((item) => item.error || "invalid synthesis response").join(" ");
    return failRow(
      row,
      `Synthesis failed after ${attempts.length} selected survivor attempt(s). ${details}`.trim(),
      "SYNTHESIS",
      now,
      true,
    );
  }
  const parsed = parseJson(synth.responseText);
  if (!parsed || (mode === "CREATE" && !parsed.artifact)) {
    return failRow(row, "Synthesis failed: invalid synthesis response.", "SYNTHESIS", now, true);
  }
  const gated = applyGate(parsed, survivingResponses([...round1, ...round2]), mode);
  const failedAgents = failedResponses(row.responses)
    .map((item) => responseMemberId(item))
    .filter((agent, index, all) => agent && all.indexOf(agent) === index);
  const packedCitations = row.cursor.manifest?.payload.evidence?.packedCitations ?? [];
  let artifact: Artifact | null = null;
  if (mode === "CREATE") {
    const drafted = parsed.artifact;
    if (!drafted) return failRow(row, "CREATE synthesis did not produce an artifact.", "SYNTHESIS", now, true);
    const sanitized = sanitizeEvidenceLabels(normalizeEvidenceLabels(drafted.evidenceLabels), packedCitations);
    artifact = {
      id: crypto.randomUUID().replaceAll("-", "").slice(0, 32),
      projectId: frozen.project.id,
      taskId: frozen.task.id,
      type: drafted.type,
      title: drafted.title,
      version: drafted.version,
      content: drafted.content,
      status: nextArtifactStatus(gated.status),
      contextHash: row.cursor.manifest?.hash ?? "",
      evidenceLabels: sanitized.labels,
      createdAt: now,
    };
  }
  if (mode === "REVIEW") {
    const candidate = frozen.artifacts.find((item) => item.id === frozen.task.candidateArtifactId) ?? null;
    if (candidate) {
      const verdict = parsed.reviewVerdict ?? reviewVerdictFromStatus(gated.status);
      artifact = { ...candidate, status: artifactStatusForReview(verdict, gated.status) };
    }
  }
  if (parsed.evidence.length) {
    parsed.evidence = sanitizeEvidenceLabels(parsed.evidence, packedCitations).labels;
  }
  let packet: ImplementationPacket | null = null;
  if (mode === "CREATE" && artifact && gated.status === "APPROVED") {
    packet = buildImplementationPacket({
      project: frozen.project,
      task: frozen.task,
      artifact,
      result: { blockers: gated.blockers, status: gated.status },
      frozen: frozen.context,
      packedCitations,
      parentPacketId: frozen.parentPacket?.id ?? null,
      iteration: frozen.parentPacket ? frozen.parentPacket.iteration + 1 : 1,
    });
  }
  const out = completeOutput(frozen.task, row.responses, parsed, gated, {
    artifact,
    manifest: row.cursor.manifest,
    packet,
    packedCitations,
    failedAgents,
  });
  row.output = out;
  row.completedAt = now;
  row.cursor.phase = "COMPLETE";
  row.cursor.stallReason = null;
  row.cursor.internalStage = "COMPLETE";
  row.cancelRequested = false;
  patchSnapshot(row, { status: "COMPLETE", stage: "COMPLETE", message: "Council complete.", now });
  row.snapshot = {
    ...row.snapshot,
    status: "COMPLETE",
    proposedStatus: gated.proposedStatus,
    reconciledStatus: gated.reconciledStatus,
    gateReason: gated.reason,
    unresolvedIssues: out.result?.unresolvedIssues ?? [],
    stallReason: null,
    internalStage: "COMPLETE",
  };
  return row;
}

export function applyStopToRow(row: DurableRunRow, now: string, message = "Council run stopped."): DurableRunRow {
  return cancelRow(row, now, message);
}

export async function advanceDurableStep(input: {
  row: DurableRunRow;
  runtime: CouncilRuntime;
  signal?: AbortSignal;
  now?: () => string;
  nowMs?: number;
}): Promise<DurableStepResult> {
  const now = () => nowIso(input.now);
  const nowMs = input.nowMs ?? Date.now();
  let row = input.row;
  row.cursor = hydrateCursor(row.cursor);
  if (stallAfterIdle({ lastActivityAt: row.cursor.lastProviderResponseAt ?? row.lastProgressAt, nowMs })) {
    row.cursor.stallReason = String(row.cursor.internalStage || "SCHEDULER_WAIT");
  } else {
    row.cursor.stallReason = null;
  }
  if (row.cursor.phase === "QUEUED" || !row.cursor.packedText) {
    row.cursor = hydrateCursor({ ...row.cursor, phase: "PREPARING", internalStage: "PREFLIGHT" });
    patchSnapshot(row, { status: "PREPARING", stage: "PREPARING", message: "Preparing the evidence packet…", now: now() });
    row = await prepare(row, input.runtime, now);
    return { row, didProviderCall: false, terminal: isTerminalStatus(row.status) };
  }
  if (isTerminalStatus(row.status)) {
    return { row, didProviderCall: false, terminal: true };
  }
  if (row.cancelRequested || isCancelledSignal(input.signal)) {
    return { row: cancelRow(row, now()), didProviderCall: false, terminal: true };
  }
  if (!row.cursor.accessOk || (row.cursor.preflight && nextPreflightStep(row.cursor.preflight))) {
    row = await advancePreflight(row, input.runtime, now, input.signal);
    return { row, didProviderCall: true, terminal: isTerminalStatus(row.status) };
  }

  const members = ensureMembers(row.members);
  const roles = rolesForMode(row.frozenInput.task.mode, members);
  const ctx = row.cursor.packedText ?? "";
  const selectedIds = members.map((item) => item.modelId);

  const pending1 = nextRound1Member(row);
  if (pending1) {
    const response = await askMember({
      row,
      member: pending1,
      callStage: "ROUND_1",
      system: roles[pending1.memberId],
      user: ctx,
      maxTokens: AGENT_MAX,
      temperature: 0.2,
      runtime: input.runtime,
      signal: input.signal,
      now,
    });
    row.responses.push(response);
    row.cursor.completedKeys.push(completedKey("ROUND_1", pending1.memberId));
    if (row.cancelRequested || isCancelledSignal(input.signal) || response.error === "Council run stopped.") {
      return { row: cancelRow(row, now()), didProviderCall: true, terminal: true };
    }
    if (!nextRound1Member(row)) {
      const fail1 = councilPartial(roundRows(row, "ROUND_1"));
      if (!fail1.ok) {
        return { row: failRow(row, fail1.reason, "ROUND_1", now(), true), didProviderCall: true, terminal: true };
      }
      row.cursor.phase = "ROUND_2";
      patchSnapshot(row, {
        status: "ROUND_2",
        stage: "ROUND_2",
        message:
          row.frozenInput.task.mode === "CREATE"
            ? "Round 2 — cross-examination of the reconstructed architecture."
            : "Round 2 — the surviving reviewers are reading each other.",
        now: now(),
      });
    }
    return { row, didProviderCall: true, terminal: false };
  }

  const pending2 = nextRound2Member(row);
  if (pending2) {
    const round1 = roundRows(row, "ROUND_1");
    const others = members
      .map((item) => {
        const prior = round1.find((entry) => responseMemberId(entry) === item.memberId);
        return `${item.memberId} ${item.role} (${item.label}) ROUND 1\n${prior?.responseText ?? "(failed)"}`;
      })
      .join("\n\n");
    const user = [
      ctx,
      `YOUR ROUND 1 POSITION\n${round1.find((entry) => responseMemberId(entry) === pending2.memberId)?.responseText ?? ""}`,
      others,
    ].join("\n\n");
    const response = await askMember({
      row,
      member: pending2,
      callStage: "ROUND_2",
      system: `${roles[pending2.memberId]}\n${ROUND2}`,
      user,
      maxTokens: AGENT_MAX,
      temperature: 0.2,
      runtime: input.runtime,
      signal: input.signal,
      now,
    });
    row.responses.push(response);
    row.cursor.completedKeys.push(completedKey("ROUND_2", pending2.memberId));
    if (row.cancelRequested || isCancelledSignal(input.signal) || response.error === "Council run stopped.") {
      return { row: cancelRow(row, now()), didProviderCall: true, terminal: true };
    }
    if (!nextRound2Member(row)) {
      const fail2 = councilPartial([...survivingResponses(roundRows(row, "ROUND_1")), ...roundRows(row, "ROUND_2")]);
      if (!fail2.ok) {
        return { row: failRow(row, fail2.reason, "ROUND_2", now(), true), didProviderCall: true, terminal: true };
      }
      row.cursor.phase = "SYNTHESIS";
      patchSnapshot(row, { status: "SYNTHESIS", stage: "SYNTHESIS", message: "Synthesis — combining the positions.", now: now() });
    }
    return { row, didProviderCall: true, terminal: false };
  }

  const round2 = roundRows(row, "ROUND_2");
  const queue = synthesizerQueue(round2, members, row.synthesizerModel).filter((item) => selectedIds.includes(item.modelId));
  if (!queue.length) {
    return { row: failRow(row, "Synthesis refused: no selected surviving member.", "SYNTHESIS", now(), true), didProviderCall: false, terminal: true };
  }
  const synthSpec = synthesisForMode(row.frozenInput.task.mode, members);
  if (row.cursor.synthIndex >= queue.length) {
    return { row: finalize(row, now()), didProviderCall: false, terminal: true };
  }
  const synthMember = queue[row.cursor.synthIndex];
  const leftover = queue.length - row.cursor.synthIndex;
  const remaining = Math.max(0, (row.snapshot.requestBudget?.limit ?? 12) - row.cursor.requestUsed);
  const per = Math.max(1, Math.min(PROVIDER_ATTEMPTS, Math.floor(Math.max(1, remaining) / leftover)));
  const aliveMembers = members.filter((member) =>
    survivingResponses(round2).some((item) => responseMemberId(item) === member.memberId),
  );
  const synthUser = [
    `CONTEXT MANIFEST HASH ${row.cursor.manifest?.hash ?? ""}`,
    ctx,
    ...aliveMembers.map((member) => {
      return `ROUND 2 ${member.memberId} ${member.role} (${member.label})\n${round2.find((item) => responseMemberId(item) === member.memberId)?.responseText ?? ""}`;
    }),
  ].join("\n\n");
  const response = await askMember({
    row,
    member: synthMember,
    callStage: "SYNTHESIS",
    system: synthSpec.prompt,
    user: synthUser,
    maxTokens: synthSpec.max,
    temperature: 0,
    responseFormat: synthSpec.schema,
    runtime: input.runtime,
    signal: input.signal,
    now,
    maxAttempts: per,
  });
  row.responses.push(response);
  row.cursor.completedKeys.push(completedKey("SYNTHESIS", `${synthMember.memberId}:${row.cursor.synthIndex}`));
  row.cursor.synthIndex += 1;
  if (!response.error) {
    const json = parseJson(response.responseText);
    const usable =
      json &&
      (!response.dispatchedModelId || response.dispatchedModelId === synthMember.modelId) &&
      selectedIds.includes(response.dispatchedModelId || synthMember.modelId) &&
      (row.frozenInput.task.mode !== "CREATE" || Boolean(json.artifact));
    if (usable) {
      return { row: finalize(row, now()), didProviderCall: true, terminal: true };
    }
  }
  if (row.cancelRequested || isCancelledSignal(input.signal) || response.error === "Council run stopped.") {
    return { row: cancelRow(row, now()), didProviderCall: true, terminal: true };
  }
  if (row.cursor.synthIndex >= queue.length) {
    return { row: finalize(row, now()), didProviderCall: true, terminal: true };
  }
  return { row, didProviderCall: true, terminal: false };
}

export function seedCursorFromResume(row: DurableRunRow): DurableRunRow {
  const resume = row.frozenInput.resumeResponses ?? [];
  if (!resume.length) return row;
  for (const item of resume) {
    if (item.round === 1 && !item.error) {
      const key = completedKey("ROUND_1", responseMemberId(item));
      if (!row.cursor.completedKeys.includes(key)) row.cursor.completedKeys.push(key);
    }
  }
  return row;
}
