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
import { councilAgentFailure, failedResponses, survivingResponses, synthesizerAgent } from "./agents.ts";
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
import { accessBlocksRun, type DiscoveredModel } from "./discover.ts";
import { assertCouncilSelection, type CouncilMember } from "./members.ts";
import type {
  AgentKey,
  AgentProgress,
  AgentResponse,
  Artifact,
  ChatMessage,
  Completion,
  ContextItem,
  ContextManifest,
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
}) => Promise<{ ok: true; completion: Completion } | { ok: false; error: string; failure?: ProviderFailure }>;

export type CouncilRuntime = {
  completeChat: CouncilCompleteChat;
  catalogCheck?: (opts: {
    provider: ProviderId;
    apiKey: string;
    models: string[];
  }) => Promise<CatalogCheckResult>;
  accessCheck?: (opts: {
    provider: ProviderId;
    apiKey: string;
    models: string[];
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
}): Promise<CatalogCheckResult> {
  const mod = await import("./run-council.ts");
  return mod.checkCatalog({ data: { provider: opts.provider, apiKey: opts.apiKey, models: opts.models } });
}

async function defaultAccessCheck(opts: {
  provider: ProviderId;
  apiKey: string;
  models: string[];
}): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }> {
  const mod = await import("./run-council.ts");
  return mod.checkAccess({ data: { provider: opts.provider, apiKey: opts.apiKey, models: opts.models } });
}

function waitingAgents(members: CouncilMember[]): Partial<Record<AgentKey, AgentProgress>> {
  return Object.fromEntries(
    members.map((row) => [
      row.role,
      { state: "WAITING" as const, attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
    ]),
  );
}

export function runCredsFromReady(config: {
  ready: boolean;
  provider: ProviderCreds["provider"];
  members: CouncilMember[];
  synthesizerModel: string;
  maxCostUsd: number;
}): ProviderCreds | null {
  if (!config.ready) return null;
  if (assertCouncilSelection(config.members.map((row) => row.modelId))) return null;
  return {
    provider: config.provider,
    apiKey: "",
    members: config.members,
    synthesizerModel: config.synthesizerModel,
    maxCostUsd: config.maxCostUsd,
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
  const members = input.creds.members;
  const agentKeys = members.map((row) => row.role);
  const selectedIds = members.map((row) => row.modelId);
  const boundTask: Task = { ...input.task, provider: runProvider, selectedModels: members };
  const precheck = councilPreflight({ task: boundTask, artifacts });
  if (!precheck.ok) {
    return precheckOutput(boundTask, precheck.error ?? "PRECHECK_FAIL");
  }

  const key = sanitizeApiKey(input.creds.apiKey, runProvider);
  const mode = input.task.mode;
  const roles = rolesForMode(mode, agentKeys);
  const candidate = input.task.candidateArtifactId
    ? artifacts.find((row) => row.id === input.task.candidateArtifactId) ?? null
    : null;
  const agents = waitingAgents(members);
  const startedAt = now();
  let stageStartedAt = startedAt;

  const models = modelFor(input.creds);
  let manifest: ContextManifest | null = null;
  const responses: AgentResponse[] = [];
  const requests = createRequestCounter(members.length);
  let spent = 0;

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

  const fail = (message: string, stage: CouncilStageName = "PREPARING") => {
    const out = failedOutput(boundTask, responses, message, { manifest });
    return stamp(out, snapshot(stage, "FAILED", message), input.task.diagnostics);
  };

  const finishCancelled = (message = "Council run stopped.") => {
    for (const member of members) {
      const current = agents[member.role];
      if (current?.state === "WAITING" || current?.state === "RUNNING") {
        agents[member.role] = { ...current, state: "FAILED", error: message };
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

    const credsError = assertRunCredentials(input.creds);
    if (credsError) {
      return precheckOutput(boundTask, credsError);
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
    });
    if (!catalog.ok) {
      const error = catalog.error ?? MODEL_UNAVAILABLE;
      return precheckOutput(boundTask, error);
    }

    if (runtime.accessCheck) {
      const access = await runtime.accessCheck({
        provider: runProvider,
        apiKey: key,
        models: selectedIds,
      });
      if (!access.ok) {
        return precheckOutput(
          boundTask,
          access.error ??
            `${MODEL_UNAVAILABLE}: ${access.blocked.map((row) => row.id).join(", ") || "selected model"} is not accessible.`,
        );
      }
    }

    throwIfCancelled(runId, signal);

    const ask = async (
      agent: AgentKey,
      round: 1 | 2 | 3,
      system: string,
      user: string,
      maxTokens: number,
      temperature: number,
      responseFormat?: Record<string, unknown>,
    ): Promise<AgentResponse> => {
      const stage = `${agent} round ${round}`;
      const modelId = models[agent];
      if (isCancelledSignal(signal)) {
        agents[agent] = {
          state: "FAILED",
          attempt: agents[agent]?.attempt ?? 0,
          maxAttempts: PROVIDER_ATTEMPTS,
          error: "Council run stopped.",
        };
        return tagRun(
          responseFromError(input.task.id, agent, round, modelId, system, user, "Council run stopped.", manifest, runProvider),
          runId,
        );
      }
      let lastFailure: ProviderFailure | null = null;
      for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt += 1) {
        if (isCancelledSignal(signal)) {
          agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: "Council run stopped." };
          return tagRun(
            responseFromError(input.task.id, agent, round, modelId, system, user, "Council run stopped.", manifest, runProvider),
            runId,
          );
        }
        try {
          requests.consume(stage);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Council stopped because the request limit was reached.";
          agents[agent] = {
            state: "FAILED",
            attempt: Math.max(0, attempt - 1),
            maxAttempts: PROVIDER_ATTEMPTS,
            error: message,
          };
          const errRow = tagRun(
            responseFromError(input.task.id, agent, round, modelId, system, user, message, manifest, runProvider),
            runId,
          );
          emit(
            round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
            round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
            message,
            { responses: [errRow] },
          );
          return errRow;
        }
        agents[agent] = { state: "RUNNING", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: null };
        emit(
          round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
          round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
          attempt > 1
            ? `${agent} retry ${attempt}/${PROVIDER_ATTEMPTS} after ${lastFailure?.httpClass ?? "error"}.`
            : `${agent} is running (${attempt}/${PROVIDER_ATTEMPTS}).`,
        );
        try {
          const out = await runtime.completeChat({
            provider: runProvider,
            apiKey: key,
            model: modelId,
            messages: chat(system, user),
            maxTokens,
            temperature,
            responseFormat,
            signal,
          });
          if (isCancelledSignal(signal) || (!out.ok && out.error === "Council run stopped.")) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: "Council run stopped." };
            return tagRun(
              responseFromError(input.task.id, agent, round, modelId, system, user, "Council run stopped.", manifest, runProvider),
              runId,
            );
          }
          if (out.ok && isEmptyCompletion(out.completion.text)) {
            lastFailure = providerFailure({
              provider: runProvider,
              model: modelId,
              stage,
              httpClass: "empty",
              raw: "empty response",
            });
          } else if (out.ok) {
            spent += out.completion.cost ?? 0;
            agents[agent] = { state: "DONE", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: null };
            const row = tagRun(
              responseFromCompletion(input.task.id, agent, round, system, user, out.completion, manifest, runProvider),
              runId,
            );
            emit(
              round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
              round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
              `${agent} finished.`,
              { responses: [row] },
            );
            return row;
          } else {
            lastFailure =
              out.failure ??
              toProviderFailure(out.error, {
                provider: runProvider,
                model: modelId,
                stage,
              });
          }
        } catch (err) {
          if (err instanceof CouncilCancelled || isCancelledSignal(signal)) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: "Council run stopped." };
            return tagRun(
              responseFromError(input.task.id, agent, round, modelId, system, user, "Council run stopped.", manifest, runProvider),
              runId,
            );
          }
          lastFailure = toProviderFailure(err, {
            provider: runProvider,
            model: modelId,
            stage,
          });
        }
        const retryable = isRetryableFailure(lastFailure);
        if (retryable && attempt < PROVIDER_ATTEMPTS) {
          if (isCancelledSignal(signal)) {
            agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: "Council run stopped." };
            return tagRun(
              responseFromError(input.task.id, agent, round, modelId, system, user, "Council run stopped.", manifest, runProvider),
              runId,
            );
          }
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        const failure = lastFailure
          ? {
              ...lastFailure,
              provider: runProvider,
              model: modelId,
              stage,
              retryExhausted: retryable,
              message: "",
            }
          : providerFailure({
              provider: runProvider,
              model: modelId,
              stage,
              retryExhausted: retryable,
            });
        failure.message = formatProviderFailure(failure);
        agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: failure.message };
        const errRow = tagRun(
          responseFromError(input.task.id, agent, round, modelId, system, user, failure.message, manifest, runProvider),
          runId,
        );
        emit(
          round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
          round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
          failure.message,
          { responses: [errRow] },
        );
        return errRow;
      }
      const fallback = providerFailure({
        provider: runProvider,
        model: modelId,
        stage,
        retryExhausted: true,
      });
      agents[agent] = {
        state: "FAILED",
        attempt: PROVIDER_ATTEMPTS,
        maxAttempts: PROVIDER_ATTEMPTS,
        error: fallback.message,
      };
      const errRow = tagRun(
        responseFromError(input.task.id, agent, round, modelId, system, user, fallback.message, manifest, runProvider),
        runId,
      );
      emit(
        round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
        round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
        fallback.message,
        { responses: [errRow] },
      );
      return errRow;
    };

    stageStartedAt = now();
    for (const member of members) {
      agents[member.role] = { state: "RUNNING", attempt: 1, maxAttempts: PROVIDER_ATTEMPTS, error: null };
    }
    emit("COUNCIL_ROUND_1", "ROUND_1", `Round 1 — ${members.length} Council models.`, { manifest });
    await yieldFn();
    throwIfCancelled(runId, signal);

    const round1 = await Promise.all(
      members.map((member) => ask(member.role, 1, roles[member.role], ctx, AGENT_MAX, 0.2)),
    );
    responses.push(...round1);
    if (isCancelledSignal(signal)) return finishCancelled();
    emit("COUNCIL_ROUND_1", "ROUND_1", "Round 1 complete.", { responses: [...responses] });
    const fail1 = councilAgentFailure(round1);
    if (fail1) {
      return fail(fail1, "ROUND_1");
    }
    const alive = survivingResponses(round1).map((row) => row.agent);

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
      alive.map((agent) => {
        const system = `${roles[agent]}\n${ROUND2}`;
        const others = members
          .map((member) => {
            const row = round1.find((item) => item.agent === member.role);
            return `${member.role} (${member.label}) ROUND 1\n${row?.responseText ?? "(failed)"}`;
          })
          .join("\n\n");
        const user = [
          ctx,
          `YOUR ROUND 1 POSITION\n${round1.find((row) => row.agent === agent)?.responseText ?? ""}`,
          others,
        ].join("\n\n");
        return ask(agent, 2, system, user, AGENT_MAX, 0.2);
      }),
    );
    responses.push(...round2);
    if (isCancelledSignal(signal)) return finishCancelled();
    emit("COUNCIL_ROUND_2", "ROUND_2", "Round 2 complete.", { responses: [...responses] });
    const fail2 = councilAgentFailure([...survivingResponses(round1), ...round2]);
    if (fail2) {
      return fail(fail2, "ROUND_2");
    }

    throwIfCancelled(runId, signal);
    const synthSpec = synthesisForMode(mode, agentKeys);
    const synthAgent = synthesizerAgent(round2, members, input.creds.synthesizerModel);
    const synthMember = members.find((row) => row.role === synthAgent);
    if (!synthMember || !selectedIds.includes(synthMember.modelId)) {
      return fail("Synthesis refused to use an unselected model.", "SYNTHESIS");
    }
    stageStartedAt = now();
    emit(
      "SYNTHESIS",
      "SYNTHESIS",
      mode === "CREATE"
        ? `Artifact synthesis — ${synthMember.label}.`
        : `Synthesis — ${synthMember.label} combining the positions.`,
    );
    const synthUser = [
      `CONTEXT MANIFEST HASH ${manifest.hash}`,
      ctx,
      ...alive.map((agent) => {
        const member = members.find((row) => row.role === agent);
        return `ROUND 2 ${agent} (${member?.label ?? agent})\n${round2.find((row) => row.agent === agent)?.responseText ?? ""}`;
      }),
    ].join("\n\n");
    const synth = await ask(synthAgent, 3, synthSpec.prompt, synthUser, synthSpec.max, 0, synthSpec.schema);
    responses.push(synth);
    if (isCancelledSignal(signal)) return finishCancelled();
    emit("SYNTHESIS", "SYNTHESIS", "Synthesis complete.", { responses: [...responses] });
    if (synth.error) {
      return fail(synth.error, "SYNTHESIS");
    }
    if (!selectedIds.includes(synth.model) && synth.model && !selectedIds.includes(models[synthAgent])) {
      return fail("Synthesis used a model that was not selected.", "SYNTHESIS");
    }
    const parsed = parseJson(synth.responseText);
    if (!parsed) {
      return fail(
        "The final Council response could not be validated. The raw response was preserved for review.",
        "SYNTHESIS",
      );
    }
    const gated = applyGate(parsed, survivingResponses(round2), mode);
    const failedAgents = failedResponses(responses)
      .map((row) => row.agent)
      .filter((agent, index, all) => all.indexOf(agent) === index);
    let artifact: Artifact | null = null;
    if (mode === "CREATE") {
      const drafted = parsed.artifact;
      if (!drafted) {
        return fail("CREATE synthesis did not produce an artifact.", "SYNTHESIS");
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
