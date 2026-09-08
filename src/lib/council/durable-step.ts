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
  retryDelayMs,
  toProviderFailure,
  type ProviderFailure,
} from "./provider-error.ts";
import { CouncilCancelled, isCancelledSignal, type CouncilStageName } from "./run-control.ts";
import { providerName } from "./providers.ts";
import { createRequestCounter, isEmptyCompletion } from "./request-budget.ts";
import { MODEL_UNAVAILABLE } from "./catalog.ts";
import { accessBlocksRun, isVerifiedAvailable } from "./discover.ts";
import { sameProviderScan } from "./provider-adapter.ts";
import { ensureMembers, findMember, type CouncilMember } from "./members.ts";
import { assertRunCredentials, type CouncilRuntime } from "./orchestrate.ts";
import { emptyCursor, isTerminalStatus, taskStatusFor, waitingAgents, completedKey, type DurableRunRow, type DurableStage, type DurableStatus } from "./durable-run.ts";
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
      ...(row.snapshot.requestBudget ?? { used: 0, limit: 12, expected: 7 }),
      used: extras.requestUsed ?? row.cursor.requestUsed,
    },
    costUsd: row.cursor.spent,
    inputTokens: row.cursor.tokenIn || null,
    outputTokens: row.cursor.tokenOut || null,
    latencyMs: row.cursor.latencyMs || null,
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
  const requests = createRequestCounter(row.members.length, row.cursor.requestUsed);
  const emit = (message: string, agentState: AgentProgress) => {
    agents[member.memberId] = agentState;
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
      requests.consume(`${member.memberId} ${member.role} ${callStage} ${dispatchedModelId}`);
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
      { state: "RUNNING", attempt, maxAttempts, error: null },
    );
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
      if (isCancelledSignal(signal) || row.cancelRequested || (!out.ok && out.error === "Council run stopped.")) {
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
        emit(`${member.label} finished.`, { state: "DONE", attempt, maxAttempts, error: null });
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
      await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
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
    emit(failure.message, { state: "FAILED", attempt, maxAttempts, error: failure.message });
    row.cursor.requestUsed = requests.used();
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
  return row.members.find((member) => !done.has(completedKey("ROUND_1", member.memberId))) ?? null;
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
  if (frozen.catalog?.length) {
    const blocked = members.filter((item) => {
      const hit = frozen.catalog?.find((model) => model.id === item.modelId);
      return !hit || accessBlocksRun(hit.access);
    });
    if (blocked.length) {
      const message = `${MODEL_UNAVAILABLE}: ${blocked.map((item) => item.modelId).join(", ")} is not accessible on ${providerName(row.provider)}. Refresh models and pick a replacement.`;
      row.output = precheckOutput(boundTask, message);
      return failRow(row, message, "PREPARING", now(), false);
    }
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

  const selectedIds = members.map((item) => item.modelId);
  const catalogFn =
    runtime.catalogCheck ??
    (async () => ({ ok: true as const, missing: [] as string[], available: selectedIds }));
  const catalog = await catalogFn({
    provider: row.provider,
    apiKey: "",
    models: selectedIds,
    nanogptBilling: row.nanogptBilling ?? undefined,
  });
  if (!catalog.ok) {
    const error = catalog.error ?? MODEL_UNAVAILABLE;
    row.output = precheckOutput(boundTask, error);
    return failRow(row, error, "PREPARING", now(), false);
  }
  row.cursor.catalogOk = true;

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
    agents[responseMemberId(item)] = { state: "DONE", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null };
    row.cursor.completedKeys.push(completedKey("ROUND_1", responseMemberId(item)));
  }
  row.responses.push(...resumeKept);
  row.snapshot.agents = agents;

  const accessFn =
    runtime.accessCheck ??
    (async () => ({ ok: true, blocked: [] as Array<{ id: string; access: string }> }));
  const kept = new Set(resumeKept.map((item) => responseMemberId(item)));
  const verifyIds = members.filter((item) => !kept.has(item.memberId)).map((item) => item.modelId);
  const access = await accessFn({
    provider: row.provider,
    apiKey: "",
    models: verifyIds.length ? verifyIds : selectedIds,
    nanogptBilling: row.nanogptBilling ?? undefined,
  });
  const accessError =
    ("error" in access ? access.error : undefined) ??
    `${MODEL_UNAVAILABLE}: ${access.blocked
      .filter((item) => !isVerifiedAvailable(item.access))
      .map((item) => `${item.id} (${item.access})`)
      .join(", ") || "selected model"} is not VERIFIED_AVAILABLE.`;
  if (!access.ok || access.blocked.some((item) => !isVerifiedAvailable(item.access))) {
    if (resumeKept.length) return failRow(row, accessError, "PREPARING", now(), true);
    row.output = precheckOutput(boundTask, accessError);
    return failRow(row, accessError, "PREPARING", now(), false);
  }
  row.cursor.accessOk = true;
  row.cursor.phase = "ROUND_1";
  patchSnapshot(row, {
    status: "ROUND_1",
    stage: "ROUND_1",
    message: `Round 1 — ${members.length} Council models.`,
    now: now(),
    agents,
  });
  return row;
}

function finalize(row: DurableRunRow, now: string): DurableRunRow {
  const frozen = row.frozenInput;
  const mode = frozen.task.mode;
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
  const gated = applyGate(parsed, survivingResponses(round2), mode);
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
  patchSnapshot(row, { status: "COMPLETE", stage: "COMPLETE", message: "Council complete.", now });
  return row;
}

export async function advanceDurableStep(input: {
  row: DurableRunRow;
  runtime: CouncilRuntime;
  signal?: AbortSignal;
  now?: () => string;
}): Promise<DurableStepResult> {
  const now = () => nowIso(input.now);
  let row = input.row;
  if (row.cursor.phase === "QUEUED" || !row.cursor.packedText) {
    row.cursor = { ...emptyCursor(), ...row.cursor, phase: "PREPARING" };
    patchSnapshot(row, { status: "PREPARING", stage: "PREPARING", message: "Preparing the evidence packet…", now: now() });
    row = await prepare(row, input.runtime, now);
    return { row, didProviderCall: true, terminal: isTerminalStatus(row.status) };
  }
  if (row.cancelRequested || isCancelledSignal(input.signal)) {
    return { row: cancelRow(row, now()), didProviderCall: false, terminal: true };
  }
  if (isTerminalStatus(row.status)) {
    return { row, didProviderCall: false, terminal: true };
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
  if (row.cancelRequested || isCancelledSignal(input.signal) || response.error === "Council run stopped.") {
    return { row: cancelRow(row, now()), didProviderCall: true, terminal: true };
  }
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
