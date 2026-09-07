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
import { sanitizeApiKey } from "./api-key.ts";
import { councilPreflight } from "./task-mode.ts";
import { CONTEXT_BUDGET_EXCEEDED, coverageBlocksCouncil } from "../evidence/pipeline.ts";
import { cachedEvidencePipeline, type EvidencePipelineResult } from "../evidence/pipeline-cache.ts";
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
import {
  CouncilCancelled,
  archiveRuns,
  isCancelledSignal,
  throwIfCancelled,
  type CouncilRunSnapshot,
  type CouncilStageName,
} from "./run-control.ts";
import { providerName } from "./providers.ts";
import { createRequestCounter, isEmptyCompletion, isRequestLimitError, type RequestBudget } from "./request-budget.ts";
import { MODEL_UNAVAILABLE, type CatalogCheckResult } from "./catalog.ts";
import { accessBlocksRun, isVerifiedAvailable, type DiscoveredModel, type DiscoverySnapshot } from "./discover.ts";
import { sameProviderScan } from "./provider-adapter.ts";
import { assertCouncilSelection, ensureMembers, findMember, type CouncilMember } from "./members.ts";
import { normalizeNanoGptBilling, type NanoGptBillingMode } from "./nano-billing.ts";
import type {
  AgentKey,
  AgentProgress,
  AgentResponse,
  Artifact,
  ChatMessage,
  Completion,
  ContextItem,
  ContextManifest,
  CouncilCallStage,
  ImplementationPacket,
  ProviderCreds,
  ProviderId,
  RunCouncilOutput,
  Task,
  TaskStatus,
  ProjectFile,
} from "./types.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";

export type CouncilStage = CouncilStageName;

export type CouncilProgress = {
  status: TaskStatus;
  message: string;
  manifest?: ContextManifest;
  stage?: CouncilStage;
  agents?: Partial<Record<AgentKey, AgentProgress>>;
  responses?: AgentResponse[];
  runId?: string;
  generation?: number;
  snapshot?: CouncilRunSnapshot;
  provider?: ProviderId;
  members?: CouncilMember[];
  requestBudget?: RequestBudget;
  costUsd?: number | null;
};

export type CouncilCompleteChat = (opts: {
  provider?: ProviderId;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
  nanogptBilling?: NanoGptBillingMode;
}) => Promise<{ ok: true; completion: Completion } | { ok: false; error: string; failure?: ProviderFailure }>;

export type CouncilRuntime = {
  completeChat: CouncilCompleteChat;
  catalogCheck?: (opts: {
    provider: ProviderId;
    apiKey: string;
    models: string[];
    nanogptBilling?: NanoGptBillingMode;
  }) => Promise<CatalogCheckResult>;
  accessCheck?: (opts: {
    provider: ProviderId;
    apiKey: string;
    models: string[];
    nanogptBilling?: NanoGptBillingMode;
  }) => Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }>;
  now?: () => string;
  yieldFn?: () => Promise<void>;
};

const defaultYield = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

async function defaultCompleteChat(
  opts: Parameters<CouncilCompleteChat>[0],
): ReturnType<CouncilCompleteChat> {
  const mod = await import("./openrouter.ts");
  return mod.completeChat(opts);
}

async function defaultCatalogCheck(opts: {
  provider: ProviderId;
  apiKey: string;
  models: string[];
  nanogptBilling?: NanoGptBillingMode;
}): Promise<CatalogCheckResult> {
  const mod = await import("./run-council.ts");
  return mod.checkCatalog({
    data: { provider: opts.provider, apiKey: opts.apiKey, models: opts.models, nanogptBilling: opts.nanogptBilling },
  });
}

async function defaultAccessCheck(opts: {
  provider: ProviderId;
  apiKey: string;
  models: string[];
  nanogptBilling?: NanoGptBillingMode;
}): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }> {
  const mod = await import("./run-council.ts");
  return mod.checkAccess({
    data: { provider: opts.provider, apiKey: opts.apiKey, models: opts.models, nanogptBilling: opts.nanogptBilling },
  });
}

function waitingAgents(members: CouncilMember[]): Partial<Record<AgentKey, AgentProgress>> {
  return Object.fromEntries(
    members.map((row) => [
      row.memberId,
      { state: "WAITING" as const, attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
    ]),
  );
}

function statusForStage(stage: CouncilCallStage): TaskStatus {
  if (stage === "SYNTHESIS") return "SYNTHESIS";
  if (stage === "ROUND_2") return "COUNCIL_ROUND_2";
  return "COUNCIL_ROUND_1";
}

function snapshotStage(stage: CouncilCallStage): CouncilStageName {
  if (stage === "SYNTHESIS") return "SYNTHESIS";
  if (stage === "ROUND_2") return "ROUND_2";
  return "ROUND_1";
}

export function runCredsFromReady(config: {
  ready: boolean;
  provider: ProviderCreds["provider"];
  members: CouncilMember[];
  synthesizerModel: string;
  maxCostUsd: number;
  nanogptBilling?: NanoGptBillingMode;
}): ProviderCreds | null {
  if (!config.ready) return null;
  if (assertCouncilSelection(config.members.map((row) => row.modelId))) return null;
  const members = ensureMembers(config.members);
  return {
    provider: config.provider,
    apiKey: "",
    members,
    synthesizerModel: config.synthesizerModel,
    maxCostUsd: config.maxCostUsd,
    nanogptBilling: config.provider === "nanogpt" ? normalizeNanoGptBilling(config.nanogptBilling) : undefined,
  };
}

export function assertRunCredentials(creds: ProviderCreds): string | null {
  const who = providerName(creds.provider);
  const pasted = typeof creds.apiKey === "string" ? creds.apiKey : "";
  if (pasted.trim()) {
    const key = sanitizeApiKey(pasted, creds.provider);
    if (!key) return `${who} is not connected. Connect your API key before running the Council.`;
  }
  const selectionError = assertCouncilSelection(creds.members.map((row) => row.modelId));
  if (selectionError) return selectionError;
  if (creds.members.some((row) => !row.modelId.trim())) {
    return "Each selected Council member needs a model id. Refresh models in API Settings.";
  }
  return null;
}

export function isStaleDisconnectError(message: string, accountReady: boolean): boolean {
  return (
    accountReady && /is not connected\. Connect your API key before running the Council/i.test(message)
  );
}

function tagRun(row: AgentResponse, runId: string): AgentResponse {
  return {
    ...row,
    runId,
    structured: { ...(row.structured ?? {}), __runId: runId },
  };
}

function stamp(
  out: RunCouncilOutput,
  snap: CouncilRunSnapshot,
  previous: Task["diagnostics"],
): RunCouncilOutput {
  out.task.diagnostics = {
    ...(out.task.diagnostics ?? previous ?? {}),
    run: snap,
    runs: archiveRuns(previous?.runs as CouncilRunSnapshot[] | undefined, snap),
  };
  return out;
}

export async function runCouncil(input: {
  creds: ProviderCreds;
  project: { id: string; name: string; description: string };
  context: ContextItem[];
  task: Task;
  chatSources?: ChatSource[];
  historyMessages?: HistoryMessage[];
  projectFiles?: ProjectFile[];
  artifacts?: Artifact[];
  parentPacket?: ImplementationPacket | null;
  pipeline?: EvidencePipelineResult;
  catalog?: DiscoveredModel[];
  scan?: DiscoverySnapshot | null;
  resume?: { responses: AgentResponse[] };
  runId?: string;
  generation?: number;
  signal?: AbortSignal;
  runtime?: CouncilRuntime;
  onProgress?: (progress: CouncilProgress) => void;
}): Promise<RunCouncilOutput> {
  const runtime: CouncilRuntime = input.runtime ?? {
    completeChat: defaultCompleteChat,
    catalogCheck: defaultCatalogCheck,
    accessCheck: defaultAccessCheck,
  };
  const yieldFn = runtime.yieldFn ?? defaultYield;
  const now = () => runtime.now?.() ?? new Date().toISOString();
  const runId = input.runId ?? crypto.randomUUID().replaceAll("-", "").slice(0, 32);
  const generation = input.generation ?? 1;
  const signal = input.signal;
  const artifacts = input.artifacts ?? [];
  const runProvider: ProviderId = input.creds.provider;
  const runBilling: NanoGptBillingMode | undefined =
    runProvider === "nanogpt" ? normalizeNanoGptBilling(input.creds.nanogptBilling ?? input.task.nanogptBilling) : undefined;
  const members = ensureMembers(input.creds.members);
  const selectedIds = members.map((row) => row.modelId);
  const boundTask: Task = {
    ...input.task,
    provider: runProvider,
    selectedModels: members,
    nanogptBilling: runBilling ?? null,
  };
  const precheck = councilPreflight({ task: boundTask, artifacts });
  if (!precheck.ok) {
    return precheckOutput(boundTask, precheck.error ?? "PRECHECK_FAIL");
  }

  const key = sanitizeApiKey(input.creds.apiKey, runProvider);
  const mode = input.task.mode;
  const roles = rolesForMode(mode, members);
  const candidate = input.task.candidateArtifactId
    ? artifacts.find((row) => row.id === input.task.candidateArtifactId) ?? null
    : null;
  const agents = waitingAgents(members);
  const resumeKept = (input.resume?.responses ?? [])
    .filter((row) => row.round === 1 && !row.error)
    .map((row) => {
      const member = findMember(members, row);
      const memberId = member?.memberId ?? responseMemberId(row);
      return tagRun(
        {
          ...row,
          runId,
          memberId,
          agent: memberId,
          role: member?.role ?? row.role,
          dispatchedModelId: row.dispatchedModelId || member?.modelId || row.model,
          stage: row.stage || "ROUND_1",
        },
        runId,
      );
    });
  for (const row of resumeKept) {
    agents[responseMemberId(row)] = { state: "DONE", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null };
  }
  const startedAt = now();
  let stageStartedAt = startedAt;

  const models = modelFor({ ...input.creds, members });
  let manifest: ContextManifest | null = null;
  const responses: AgentResponse[] = [];
  const requests = createRequestCounter(members.length);
  let spent: number | null = null;
  let tokenIn = 0;
  let tokenOut = 0;
  let latencyMs = 0;

  const snapshot = (stage: CouncilStageName, status: TaskStatus, message: string): CouncilRunSnapshot => ({
    runId,
    generation,
    stage,
    status,
    startedAt,
    stageStartedAt,
    updatedAt: now(),
    agents: { ...agents },
    message,
    provider: runProvider,
    members,
    synthesizerModel: input.creds.synthesizerModel,
    requestBudget: requests.snapshot(),
    costUsd: spent,
    inputTokens: tokenIn || null,
    outputTokens: tokenOut || null,
    latencyMs: latencyMs || null,
    partial: false,
    synthesisSkipped: null,
    nanogptBilling: runBilling,
  });

  const emit = (status: TaskStatus, stage: CouncilStageName, message: string, extra?: Partial<CouncilProgress>) => {
    const snap = snapshot(stage, status, message);
    input.onProgress?.({
      status,
      stage,
      agents: { ...agents },
      message,
      runId,
      generation,
      snapshot: snap,
      provider: runProvider,
      members,
      requestBudget: requests.snapshot(),
      costUsd: spent,
      ...extra,
    });
  };

  const fail = (message: string, stage: CouncilStageName = "PREPARING", extras?: { partial?: boolean }) => {
    const snap = snapshot(stage, "FAILED", message);
    if (extras?.partial) {
      snap.partial = true;
      snap.synthesisSkipped = message;
    }
    const out = failedOutput(boundTask, responses, message, { manifest });
    return stamp(out, snap, input.task.diagnostics);
  };

  const finishCancelled = (message = "Council run stopped.") => {
    for (const member of members) {
      const current = agents[member.memberId];
      if (current?.state === "WAITING" || current?.state === "RUNNING") {
        agents[member.memberId] = { ...current, state: "FAILED", error: message };
      }
    }
    emit("CANCELLED", "CANCELLED", message, { responses: [...responses] });
    const out = cancelledOutput(boundTask, responses, { manifest, message });
    return stamp(out, snapshot("CANCELLED", "CANCELLED", message), input.task.diagnostics);
  };

  emit("PREPARING", "PREPARING", "Preparing the evidence packet…");

  try {
    await yieldFn();
    throwIfCancelled(runId, signal);

    const credsError = assertRunCredentials({ ...input.creds, members });
    if (credsError) {
      return precheckOutput(boundTask, credsError);
    }

    const scanMix = sameProviderScan(input.scan ?? null, runProvider, runBilling);
    if (scanMix) {
      return precheckOutput(boundTask, scanMix);
    }

    if (input.catalog?.length) {
      const blocked = members.filter((row) => {
        const hit = input.catalog?.find((item) => item.id === row.modelId);
        return !hit || accessBlocksRun(hit.access);
      });
      if (blocked.length) {
        return precheckOutput(
          boundTask,
          `${MODEL_UNAVAILABLE}: ${blocked.map((row) => row.modelId).join(", ")} is not accessible on ${providerName(runProvider)}. Refresh models and pick a replacement.`,
        );
      }
    }

    const pipelineInput = {
      project: input.project,
      task: boundTask,
      frozen: input.context.filter((row) => row.kind !== "RAW_HISTORY"),
      chatSources: input.chatSources ?? [],
      historyMessages: input.historyMessages ?? [],
      projectFiles: (input.projectFiles ?? []).filter((file) => (input.task.selectedFileIds ?? []).includes(file.id)),
      candidateText: candidate ? `# ${candidate.title} v${candidate.version}\n\n${candidate.content}` : null,
    };
    const pipeline = input.pipeline ?? cachedEvidencePipeline(pipelineInput);
    const coverageError = coverageBlocksCouncil(pipeline.coverage);
    if (coverageError) {
      return precheckOutput(boundTask, coverageError);
    }
    if (!pipeline.pack.ok) {
      return precheckOutput(boundTask, CONTEXT_BUDGET_EXCEEDED);
    }
    const ctx = pipeline.pack.text;
    const packedCitations = pipeline.manifest.packedCitations;
    manifest = persistableManifest({
      project: { id: input.project.id, name: input.project.name, description: input.project.description, createdAt: "" },
      task: boundTask,
      context: input.context,
      chatSources: input.chatSources ?? [],
      historyMessages: input.historyMessages ?? [],
      artifacts,
      projectFiles: input.projectFiles ?? [],
      contextText: ctx,
      evidence: pipeline.manifest,
    });

    throwIfCancelled(runId, signal);

    const catalogFn =
      runtime.catalogCheck ??
      (input.runtime
        ? async (): Promise<CatalogCheckResult> => ({ ok: true, missing: [], available: selectedIds })
        : defaultCatalogCheck);
    const catalog = await catalogFn({
      provider: runProvider,
      apiKey: key,
      models: selectedIds,
      nanogptBilling: runBilling,
    });
    if (!catalog.ok) {
      const error = catalog.error ?? MODEL_UNAVAILABLE;
      return precheckOutput(boundTask, error);
    }

    const accessFn =
      runtime.accessCheck ??
      (input.runtime
        ? async (): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }> => ({
            ok: true,
            blocked: [],
          })
        : defaultAccessCheck);
    const verifyIds = (() => {
      const kept = new Set(resumeKept.map((row) => responseMemberId(row)));
      const retry = members.filter((row) => !kept.has(row.memberId)).map((row) => row.modelId);
      return retry.length ? retry : selectedIds;
    })();
    const access = await accessFn({
      provider: runProvider,
      apiKey: key,
      models: verifyIds,
      nanogptBilling: runBilling,
    });
    const accessError =
      access.error ??
      `${MODEL_UNAVAILABLE}: ${access.blocked
        .filter((row) => !isVerifiedAvailable(row.access))
        .map((row) => `${row.id} (${row.access})`)
        .join(", ") || "selected model"} is not VERIFIED_AVAILABLE.`;
    if (!access.ok || access.blocked.some((row) => !isVerifiedAvailable(row.access))) {
      if (resumeKept.length) {
        responses.push(...resumeKept);
        emit("FAILED", "PREPARING", accessError, { responses: [...responses] });
        return fail(accessError, "PREPARING", { partial: true });
      }
      return precheckOutput(boundTask, accessError);
    }

    throwIfCancelled(runId, signal);

    const ask = async (
      member: CouncilMember,
      callStage: CouncilCallStage,
      system: string,
      user: string,
      maxTokens: number,
      temperature: number,
      responseFormat?: Record<string, unknown>,
      maxAttempts = PROVIDER_ATTEMPTS,
    ): Promise<AgentResponse> => {
      const agent = member.memberId;
      const dispatchedModelId = member.modelId.trim();
      const mapped = models[member.memberId];
      if (mapped && mapped !== dispatchedModelId) {
        const mismatch = `DISPATCHED_MODEL_ID ${mapped} does not equal selected model ${dispatchedModelId} for ${member.memberId}.`;
        agents[agent] = { state: "FAILED", attempt: 0, maxAttempts, error: mismatch };
        return tagRun(
          responseFromError(
            input.task.id,
            member,
            callStage,
            dispatchedModelId,
            system,
            user,
            mismatch,
            manifest,
            runProvider,
            0,
          ),
          runId,
        );
      }
      const stage = `${member.memberId} ${member.role} ${callStage} ${dispatchedModelId}`;
      const taskStatus = statusForStage(callStage);
      const emitStage = snapshotStage(callStage);
      const errRow = (message: string, attempt: number | null) =>
        tagRun(
          responseFromError(
            input.task.id,
            member,
            callStage,
            dispatchedModelId,
            system,
            user,
            message,
            manifest,
            runProvider,
            attempt,
          ),
          runId,
        );
      if (isCancelledSignal(signal)) {
        agents[agent] = {
          state: "FAILED",
          attempt: agents[agent]?.attempt ?? 0,
          maxAttempts,
          error: "Council run stopped.",
        };
        return errRow("Council run stopped.", agents[agent]?.attempt ?? 0);
      }
      let lastFailure: ProviderFailure | null = null;
      const attempts = Math.max(1, maxAttempts);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (isCancelledSignal(signal)) {
          agents[agent] = { state: "FAILED", attempt, maxAttempts: attempts, error: "Council run stopped." };
          return errRow("Council run stopped.", attempt);
        }
        try {
          requests.consume(stage);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Council stopped because the request limit was reached.";
          agents[agent] = {
            state: "FAILED",
            attempt: Math.max(0, attempt - 1),
            maxAttempts: attempts,
            error: message,
          };
          const row = errRow(message, Math.max(0, attempt - 1));
          emit(taskStatus, emitStage, message, { responses: [row] });
          return row;
        }
        agents[agent] = { state: "RUNNING", attempt, maxAttempts: attempts, error: null };
        emit(
          taskStatus,
          emitStage,
          attempt > 1
            ? `${member.label} retry ${attempt}/${attempts} after ${lastFailure?.errorClass ?? lastFailure?.httpClass ?? "error"}.`
            : `${member.label} is running (${attempt}/${attempts}).`,
        );
        try {
          const out = await runtime.completeChat({
            provider: runProvider,
            apiKey: key,
            model: dispatchedModelId,
            messages: chat(system, user),
            maxTokens,
            temperature,
            responseFormat,
            signal,
            nanogptBilling: runBilling,
          });
          if (isCancelledSignal(signal) || (!out.ok && out.error === "Council run stopped.")) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: attempts, error: "Council run stopped." };
            return errRow("Council run stopped.", attempt);
          }
          if (out.ok && isEmptyCompletion(out.completion.text)) {
            lastFailure = providerFailure({
              provider: runProvider,
              model: dispatchedModelId,
              stage,
              httpClass: "empty",
              errorClass: "EMPTY_RESPONSE",
              attempt,
              maxAttempts: attempts,
              raw: "empty response",
              requestId: out.completion.requestId,
            });
          } else if (out.ok) {
            if (out.completion.inputTokens != null) tokenIn += out.completion.inputTokens;
            if (out.completion.outputTokens != null) tokenOut += out.completion.outputTokens;
            if (out.completion.latencyMs != null) latencyMs += out.completion.latencyMs;
            if (out.completion.cost != null) spent = (spent ?? 0) + out.completion.cost;
            agents[agent] = { state: "DONE", attempt, maxAttempts: attempts, error: null };
            const row = tagRun(
              responseFromCompletion(
                input.task.id,
                member,
                callStage,
                system,
                user,
                out.completion,
                manifest,
                runProvider,
                attempt,
              ),
              runId,
            );
            emit(taskStatus, emitStage, `${member.label} finished.`, { responses: [row] });
            return row;
          } else {
            lastFailure =
              out.failure ??
              toProviderFailure(out.error, {
                provider: runProvider,
                model: dispatchedModelId,
                stage,
              });
            lastFailure = {
              ...lastFailure,
              attempt,
              maxAttempts: attempts,
              message: formatProviderFailure({ ...lastFailure, attempt, maxAttempts: attempts }),
            };
          }
        } catch (err) {
          if (err instanceof CouncilCancelled || isCancelledSignal(signal)) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: attempts, error: "Council run stopped." };
            return errRow("Council run stopped.", attempt);
          }
          lastFailure = toProviderFailure(err, {
            provider: runProvider,
            model: dispatchedModelId,
            stage,
          });
          lastFailure = {
            ...lastFailure,
            attempt,
            maxAttempts: attempts,
            message: formatProviderFailure({ ...lastFailure, attempt, maxAttempts: attempts }),
          };
        }
        const retryable = isRetryableFailure(lastFailure);
        if (retryable && attempt < attempts) {
          if (isCancelledSignal(signal)) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: attempts, error: "Council run stopped." };
            return errRow("Council run stopped.", attempt);
          }
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        const failure = lastFailure
          ? {
              ...lastFailure,
              provider: runProvider,
              model: dispatchedModelId,
              stage,
              attempt,
              maxAttempts: attempts,
              retryExhausted: retryable,
              message: "",
            }
          : providerFailure({
              provider: runProvider,
              model: dispatchedModelId,
              stage,
              attempt,
              maxAttempts: attempts,
              retryExhausted: retryable,
              errorClass: "PROVIDER_ERROR",
            });
        failure.message = formatProviderFailure(failure);
        agents[agent] = { state: "FAILED", attempt, maxAttempts: attempts, error: failure.message };
        const row = errRow(failure.message, attempt);
        emit(taskStatus, emitStage, failure.message, { responses: [row] });
        return row;
      }
      const fallback = providerFailure({
        provider: runProvider,
        model: dispatchedModelId,
        stage,
        attempt: attempts,
        maxAttempts: attempts,
        retryExhausted: true,
        errorClass: "PROVIDER_ERROR",
      });
      agents[agent] = {
        state: "FAILED",
        attempt: attempts,
        maxAttempts: attempts,
        error: fallback.message,
      };
      const row = errRow(fallback.message, attempts);
      emit(taskStatus, emitStage, fallback.message, { responses: [row] });
      return row;
    };

    stageStartedAt = now();
    for (const member of members) {
      const kept = resumeKept.some((row) => responseMemberId(row) === member.memberId);
      agents[member.memberId] = kept
        ? { state: "DONE", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null }
        : { state: "RUNNING", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null };
    }
    const priorByAgent = new Map(resumeKept.map((row) => [responseMemberId(row), row]));
    emit("COUNCIL_ROUND_1", "ROUND_1", `Round 1 — ${members.length} Council models.`, { manifest });
    await yieldFn();
    throwIfCancelled(runId, signal);

    const round1 = await Promise.all(
      members.map(async (member) => {
        const kept = priorByAgent.get(member.memberId);
        if (kept) {
          agents[member.memberId] = { state: "DONE", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null };
          return kept;
        }
        return ask(member, "ROUND_1", roles[member.memberId], ctx, AGENT_MAX, 0.2);
      }),
    );
    responses.push(...round1);
    if (isCancelledSignal(signal)) return finishCancelled();
    emit("COUNCIL_ROUND_1", "ROUND_1", "Round 1 complete.", { responses: [...responses] });
    const fail1 = councilPartial(round1);
    if (!fail1.ok) {
      emit("FAILED", "ROUND_1", fail1.reason, { responses: [...responses] });
      return fail(fail1.reason, "ROUND_1", { partial: true });
    }
    const aliveMembers = members.filter((member) =>
      survivingResponses(round1).some((row) => responseMemberId(row) === member.memberId),
    );

    throwIfCancelled(runId, signal);
    stageStartedAt = now();
    emit(
      "COUNCIL_ROUND_2",
      "ROUND_2",
      mode === "CREATE"
        ? "Round 2 — cross-examination of the reconstructed architecture."
        : "Round 2 — the surviving reviewers are reading each other.",
    );
    const round2 = await Promise.all(
      aliveMembers.map((member) => {
        const system = `${roles[member.memberId]}\n${ROUND2}`;
        const others = members
          .map((row) => {
            const prior = round1.find((item) => responseMemberId(item) === row.memberId);
            return `${row.memberId} ${row.role} (${row.label}) ROUND 1\n${prior?.responseText ?? "(failed)"}`;
          })
          .join("\n\n");
        const user = [
          ctx,
          `YOUR ROUND 1 POSITION\n${round1.find((row) => responseMemberId(row) === member.memberId)?.responseText ?? ""}`,
          others,
        ].join("\n\n");
        return ask(member, "ROUND_2", system, user, AGENT_MAX, 0.2);
      }),
    );
    responses.push(...round2);
    if (isCancelledSignal(signal)) return finishCancelled();
    emit("COUNCIL_ROUND_2", "ROUND_2", "Round 2 complete.", { responses: [...responses] });
    const fail2 = councilPartial([...survivingResponses(round1), ...round2]);
    if (!fail2.ok) {
      emit("FAILED", "ROUND_2", fail2.reason, { responses: [...responses] });
      return fail(fail2.reason, "ROUND_2", { partial: true });
    }

    throwIfCancelled(runId, signal);
    const synthSpec = synthesisForMode(mode, members);
    const queue = synthesizerQueue(round2, members, input.creds.synthesizerModel).filter((row) =>
      selectedIds.includes(row.modelId),
    );
    if (!queue.length) {
      return fail("Synthesis refused: no selected surviving member.", "SYNTHESIS", { partial: true });
    }
    stageStartedAt = now();
    emit(
      "SYNTHESIS",
      "SYNTHESIS",
      mode === "CREATE"
        ? `Artifact synthesis — ${queue[0].label}.`
        : `Synthesis — ${queue[0].label} combining the positions.`,
    );
    const synthUser = [
      `CONTEXT MANIFEST HASH ${manifest.hash}`,
      ctx,
      ...aliveMembers.map((member) => {
        return `ROUND 2 ${member.memberId} ${member.role} (${member.label})\n${round2.find((row) => responseMemberId(row) === member.memberId)?.responseText ?? ""}`;
      }),
    ].join("\n\n");

    const remainingBudget = () => {
      const snap = requests.snapshot();
      return Math.max(0, snap.limit - snap.used);
    };
    const synthAttempts: AgentResponse[] = [];
    let synth: AgentResponse | null = null;
    let parsed: ReturnType<typeof parseJson> = null;
    for (let i = 0; i < queue.length; i += 1) {
      const synthMember = queue[i];
      if (!selectedIds.includes(synthMember.modelId)) continue;
      const leftover = queue.length - i;
      const per = Math.max(1, Math.min(PROVIDER_ATTEMPTS, Math.floor(Math.max(1, remainingBudget()) / leftover)));
      emit(
        "SYNTHESIS",
        "SYNTHESIS",
        i === 0
          ? `Synthesis — ${synthMember.label}.`
          : `Preferred synthesizer failed. Trying next selected survivor ${synthMember.label}.`,
      );
      const row = await ask(
        synthMember,
        "SYNTHESIS",
        synthSpec.prompt,
        synthUser,
        synthSpec.max,
        0,
        synthSpec.schema,
        per,
      );
      synthAttempts.push(row);
      responses.push(row);
      if (isCancelledSignal(signal)) return finishCancelled();
      if (row.error) continue;
      if (row.dispatchedModelId && row.dispatchedModelId !== synthMember.modelId) {
        continue;
      }
      if (!selectedIds.includes(row.dispatchedModelId || synthMember.modelId)) continue;
      const json = parseJson(row.responseText);
      if (!json) continue;
      if (mode === "CREATE" && !json.artifact) continue;
      synth = row;
      parsed = json;
      break;
    }
    emit("SYNTHESIS", "SYNTHESIS", synth ? "Synthesis complete." : "Synthesis failed.", { responses: [...responses] });
    if (!synth || !parsed) {
      const details = synthAttempts
        .map((row) => row.error || "invalid synthesis response")
        .join(" ");
      return fail(
        `Synthesis failed after ${synthAttempts.length} selected survivor attempt(s). ${details}`.trim(),
        "SYNTHESIS",
        { partial: true },
      );
    }
    const gated = applyGate(parsed, survivingResponses(round2), mode);
    const failedAgents = failedResponses(responses)
      .map((row) => responseMemberId(row))
      .filter((agent, index, all) => agent && all.indexOf(agent) === index);
    let artifact: Artifact | null = null;
    if (mode === "CREATE") {
      const drafted = parsed.artifact;
      if (!drafted) {
        return fail("CREATE synthesis did not produce an artifact.", "SYNTHESIS", { partial: true });
      }
      const sanitized = sanitizeEvidenceLabels(
        normalizeEvidenceLabels(drafted.evidenceLabels),
        packedCitations,
      );
      artifact = {
        id: crypto.randomUUID().replaceAll("-", "").slice(0, 32),
        projectId: input.project.id,
        taskId: input.task.id,
        type: drafted.type,
        title: drafted.title,
        version: drafted.version,
        content: drafted.content,
        status: nextArtifactStatus(gated.status),
        contextHash: manifest.hash,
        evidenceLabels: sanitized.labels,
        createdAt: new Date().toISOString(),
      };
    }
    if (mode === "REVIEW" && candidate) {
      const verdict = parsed.reviewVerdict ?? reviewVerdictFromStatus(gated.status);
      artifact = {
        ...candidate,
        status: artifactStatusForReview(verdict, gated.status),
      };
    }
    if (parsed.evidence.length) {
      parsed.evidence = sanitizeEvidenceLabels(parsed.evidence, packedCitations).labels;
    }
    let packet: ImplementationPacket | null = null;
    if (mode === "CREATE" && artifact && gated.status === "APPROVED") {
      packet = buildImplementationPacket({
        project: input.project,
        task: input.task,
        artifact,
        result: { blockers: gated.blockers, status: gated.status },
        frozen: input.context,
        packedCitations,
        parentPacketId: input.parentPacket?.id ?? null,
        iteration: input.parentPacket ? input.parentPacket.iteration + 1 : 1,
      });
    }
    const out = completeOutput(boundTask, responses, parsed, gated, {
      artifact,
      manifest,
      packet,
      packedCitations,
      failedAgents,
    });
    stageStartedAt = now();
    const snap = snapshot("COMPLETE", "COMPLETE", "Council complete.");
    stamp(out, snap, input.task.diagnostics);
    emit("COMPLETE", "COMPLETE", "Council complete.", { responses: [...responses] });
    return out;
  } catch (err) {
    if (err instanceof CouncilCancelled || isCancelledSignal(signal)) {
      return finishCancelled();
    }
    const message =
      err instanceof Error && isRequestLimitError(err.message)
        ? err.message
        : formatProviderFailure(
            toProviderFailure(err, {
              provider: runProvider,
              model: "",
              stage: "Council",
            }),
          );
    return fail(message);
  }
}
