import { completeChat, testProvider } from "./openrouter";
import { nextArtifactStatus, normalizeEvidenceLabels } from "./artifact";
import { persistableManifest } from "./manifest";
import {
  AGENT_MAX,
  AGENTS,
  applyGate,
  chat,
  completeOutput,
  estimateCost,
  failedOutput,
  modelFor,
  nid,
  parseJson,
  precheckOutput,
  responseFromCompletion,
  responseFromError,
  ROUND2,
  rolesForMode,
  synthesisForMode,
} from "./protocol";
import { sanitizeApiKey } from "./api-key";
import { councilPreflight } from "./task-mode";
import { CONTEXT_BUDGET_EXCEEDED, coverageBlocksCouncil } from "@/lib/evidence/pipeline";
import { cachedEvidencePipeline, type EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { countTokens } from "@/lib/evidence/tokens";
import { councilAgentFailure, failedResponses, survivingResponses, synthesizerAgent } from "./agents";
import { sanitizeEvidenceLabels } from "./citations";
import { buildImplementationPacket } from "./packet";
import { artifactStatusForReview, reviewVerdictFromStatus } from "./review";
import {
  PROVIDER_ATTEMPTS,
  formatProviderFailure,
  isRetryableFailure,
  providerFailure,
  retryDelayMs,
  toProviderFailure,
  type ProviderFailure,
} from "./provider-error";
import type {
  AgentKey,
  AgentProgress,
  AgentResponse,
  Artifact,
  ContextItem,
  ContextManifest,
  ImplementationPacket,
  ProviderCreds,
  RunCouncilOutput,
  Task,
  TaskStatus,
} from "./types";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";
import type { ProjectFile } from "./types";

export type CouncilStage = "PREPARING" | "ROUND_1" | "ROUND_2" | "SYNTHESIS";

export type CouncilProgress = {
  status: TaskStatus;
  message: string;
  manifest?: ContextManifest;
  stage?: CouncilStage;
  agents?: Partial<Record<AgentKey, AgentProgress>>;
  responses?: AgentResponse[];
};

function waitingAgents(): Record<AgentKey, AgentProgress> {
  return {
    GPT: { state: "WAITING", attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
    GROK: { state: "WAITING", attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
    CLAUDE: { state: "WAITING", attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
  };
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
  onProgress?: (progress: CouncilProgress) => void;
}): Promise<RunCouncilOutput> {
  const artifacts = input.artifacts ?? [];
  const precheck = councilPreflight({ task: input.task, artifacts });
  if (!precheck.ok) {
    return precheckOutput(input.task, precheck.error ?? "PRECHECK_FAIL");
  }

  const key = sanitizeApiKey(input.creds.apiKey, input.creds.provider);
  const providerName = input.creds.provider === "openrusrouter" ? "OpenRusRouter" : "OpenRouter";
  const mode = input.task.mode;
  const roles = rolesForMode(mode);
  const candidate = input.task.candidateArtifactId
    ? artifacts.find((row) => row.id === input.task.candidateArtifactId) ?? null
    : null;
  const agents = waitingAgents();

  input.onProgress?.({
    status: "PREPARING",
    stage: "PREPARING",
    agents,
    message: "Preparing the evidence packet…",
  });

  const pipelineInput = {
    project: input.project,
    task: input.task,
    frozen: input.context.filter((row) => row.kind !== "RAW_HISTORY"),
    chatSources: input.chatSources ?? [],
    historyMessages: input.historyMessages ?? [],
    projectFiles: (input.projectFiles ?? []).filter((file) => (input.task.selectedFileIds ?? []).includes(file.id)),
    candidateText: candidate ? `# ${candidate.title} v${candidate.version}\n\n${candidate.content}` : null,
  };
  const pipeline = input.pipeline ?? cachedEvidencePipeline(pipelineInput);
  const coverageError = coverageBlocksCouncil(pipeline.coverage);
  if (coverageError) {
    return precheckOutput(input.task, coverageError);
  }
  if (!pipeline.pack.ok) {
    return precheckOutput(input.task, CONTEXT_BUDGET_EXCEEDED);
  }
  const ctx = pipeline.pack.text;
  const packedCitations = pipeline.manifest.packedCitations;
  const manifest: ContextManifest = persistableManifest({
    project: { id: input.project.id, name: input.project.name, description: input.project.description, createdAt: "" },
    task: input.task,
    context: input.context,
    chatSources: input.chatSources ?? [],
    historyMessages: input.historyMessages ?? [],
    artifacts,
    projectFiles: input.projectFiles ?? [],
    contextText: ctx,
    evidence: pipeline.manifest,
  });

  input.onProgress?.({
    status: "COUNCIL_ROUND_1",
    stage: "ROUND_1",
    agents,
    message: `Checking ${providerName} and the three review models…`,
    manifest,
  });

  const pre = await testProvider({
    provider: input.creds.provider,
    apiKey: key,
    gptModel: input.creds.gptModel,
    grokModel: input.creds.grokModel,
    claudeModel: input.creds.claudeModel,
    maxCostUsd: input.creds.maxCostUsd,
  });
  if (!pre.ok) {
    return failedOutput(input.task, [], pre.error ?? `${providerName} is not connected.`, { manifest });
  }

  const models = modelFor(input.creds);
  const responses: AgentResponse[] = [];
  const budget = input.creds.maxCostUsd > 0 ? input.creds.maxCostUsd : 1;
  let spent = 0;

  const spend = (text: string, maxOut: number, stage: string) => {
    const est = estimateCost(countTokens(text), maxOut);
    if (spent + est > budget) {
      throw new Error("Council stopped because the configured cost limit was reached. (" + stage + ")");
    }
    return est;
  };

  const emit = (status: TaskStatus, stage: CouncilStage, message: string, extra?: Partial<CouncilProgress>) => {
    input.onProgress?.({ status, stage, agents: { ...agents }, message, ...extra });
  };

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
    let est = 0;
    try {
      est = spend(`${system}${user}`, maxTokens, stage);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Council stopped because the configured cost limit was reached.";
      agents[agent] = { state: "FAILED", attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: message };
      const errRow = responseFromError(input.task.id, agent, round, models[agent], system, user, message, manifest);
      emit(round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1", round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1", message, {
        responses: [errRow],
      });
      return errRow;
    }
    let lastFailure: ProviderFailure | null = null;
    for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS; attempt += 1) {
      agents[agent] = { state: "RUNNING", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: null };
      emit(
        round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
        round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
        attempt > 1
          ? `${agent} retry ${attempt}/${PROVIDER_ATTEMPTS} after ${lastFailure?.httpClass ?? "error"}.`
          : `${agent} is running (${attempt}/${PROVIDER_ATTEMPTS}).`,
      );
      try {
        const out = await completeChat({
          provider: input.creds.provider,
          apiKey: key,
          model: models[agent],
          messages: chat(system, user),
          maxTokens,
          temperature,
          responseFormat,
        });
        if (out.ok) {
          spent += out.completion.cost ?? est;
          agents[agent] = { state: "DONE", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: null };
          const row = responseFromCompletion(input.task.id, agent, round, system, user, out.completion, manifest);
          emit(
            round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
            round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
            `${agent} finished.`,
            { responses: [row] },
          );
          return row;
        }
        lastFailure =
          out.failure ??
          toProviderFailure(out.error, {
            provider: input.creds.provider,
            model: models[agent],
            stage,
          });
      } catch (err) {
        lastFailure = toProviderFailure(err, {
          provider: input.creds.provider,
          model: models[agent],
          stage,
        });
      }
      const retryable = isRetryableFailure(lastFailure);
      if (retryable && attempt < PROVIDER_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        continue;
      }
      const failure = lastFailure
        ? {
            ...lastFailure,
            provider: input.creds.provider,
            model: models[agent],
            stage,
            retryExhausted: retryable,
            message: "",
          }
        : providerFailure({
            provider: input.creds.provider,
            model: models[agent],
            stage,
            retryExhausted: retryable,
          });
      failure.message = formatProviderFailure(failure);
      agents[agent] = { state: "FAILED", attempt, maxAttempts: PROVIDER_ATTEMPTS, error: failure.message };
      const errRow = responseFromError(input.task.id, agent, round, models[agent], system, user, failure.message, manifest);
      emit(
        round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
        round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
        failure.message,
        { responses: [errRow] },
      );
      return errRow;
    }
    const fallback = providerFailure({
      provider: input.creds.provider,
      model: models[agent],
      stage,
      retryExhausted: true,
    });
    agents[agent] = { state: "FAILED", attempt: PROVIDER_ATTEMPTS, maxAttempts: PROVIDER_ATTEMPTS, error: fallback.message };
    const errRow = responseFromError(input.task.id, agent, round, models[agent], system, user, fallback.message, manifest);
    emit(
      round === 3 ? "SYNTHESIS" : round === 2 ? "COUNCIL_ROUND_2" : "COUNCIL_ROUND_1",
      round === 3 ? "SYNTHESIS" : round === 2 ? "ROUND_2" : "ROUND_1",
      fallback.message,
      { responses: [errRow] },
    );
    return errRow;
  };

  try {
    emit("COUNCIL_ROUND_1", "ROUND_1", "Round 1 — GPT, Grok, and Claude.");
    const round1 = await Promise.all(AGENTS.map((agent) => ask(agent, 1, roles[agent], ctx, AGENT_MAX, 0.2)));
    responses.push(...round1);
    emit("COUNCIL_ROUND_1", "ROUND_1", "Round 1 complete.", { responses: [...responses] });
    const fail1 = councilAgentFailure(round1);
    if (fail1) {
      return failedOutput(input.task, responses, fail1, { manifest });
    }
    const alive = survivingResponses(round1).map((row) => row.agent);

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
        const user = [
          ctx,
          `YOUR ROUND 1 POSITION\n${round1.find((row) => row.agent === agent)?.responseText ?? ""}`,
          `GPT ROUND 1\n${round1.find((row) => row.agent === "GPT")?.responseText ?? "(failed)"}`,
          `GROK ROUND 1\n${round1.find((row) => row.agent === "GROK")?.responseText ?? "(failed)"}`,
          `CLAUDE ROUND 1\n${round1.find((row) => row.agent === "CLAUDE")?.responseText ?? "(failed)"}`,
        ].join("\n\n");
        return ask(agent, 2, system, user, AGENT_MAX, 0.2);
      }),
    );
    responses.push(...round2);
    emit("COUNCIL_ROUND_2", "ROUND_2", "Round 2 complete.", { responses: [...responses] });
    const fail2 = councilAgentFailure([...survivingResponses(round1), ...round2]);
    if (fail2) {
      return failedOutput(input.task, responses, fail2, { manifest });
    }

    const synthSpec = synthesisForMode(mode);
    const synthAgent = synthesizerAgent(round2);
    emit(
      "SYNTHESIS",
      "SYNTHESIS",
      mode === "CREATE"
        ? "Artifact synthesis — writing the canonical document from Round 1 and Round 2."
        : "Synthesis — combining the positions and applying the safety gate.",
    );
    const synthUser = [
      `CONTEXT MANIFEST HASH ${manifest.hash}`,
      ctx,
      ...alive.map((agent) => `ROUND 2 ${agent}\n${round2.find((row) => row.agent === agent)?.responseText ?? ""}`),
    ].join("\n\n");
    const synth = await ask(synthAgent, 3, synthSpec.prompt, synthUser, synthSpec.max, 0, synthSpec.schema);
    responses.push(synth);
    emit("SYNTHESIS", "SYNTHESIS", "Synthesis complete.", { responses: [...responses] });
    if (synth.error) {
      return failedOutput(input.task, responses, synth.error, { manifest });
    }
    const parsed = parseJson(synth.responseText);
    if (!parsed) {
      return failedOutput(
        input.task,
        responses,
        "The final Council response could not be validated. The raw response was preserved for review.",
        { manifest },
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
        return failedOutput(input.task, responses, "CREATE synthesis did not produce an artifact.", { manifest });
      }
      const sanitized = sanitizeEvidenceLabels(
        normalizeEvidenceLabels(drafted.evidenceLabels),
        packedCitations,
      );
      artifact = {
        id: nid(),
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
    return completeOutput(input.task, responses, parsed, gated, {
      artifact,
      manifest,
      packet,
      packedCitations,
      failedAgents,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.message.toLowerCase().includes("cost limit")
        ? "Council stopped because the configured cost limit was reached."
        : formatProviderFailure(
            toProviderFailure(err, {
              provider: input.creds.provider,
              model: "",
              stage: "Council",
            }),
          );
    return failedOutput(input.task, responses, message, { manifest });
  }
}
