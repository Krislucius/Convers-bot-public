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
import { CONTEXT_BUDGET_EXCEEDED, coverageBlocksCouncil, runEvidencePipeline } from "@/lib/evidence/pipeline";
import type {
  AgentKey,
  AgentResponse,
  Artifact,
  ContextItem,
  ContextManifest,
  ProviderCreds,
  RunCouncilOutput,
  Task,
  TaskStatus,
} from "./types";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";
import type { ProjectFile } from "./types";

export type CouncilProgress = {
  status: TaskStatus;
  message: string;
  manifest?: ContextManifest;
};

export async function runCouncil(input: {
  creds: ProviderCreds;
  project: { id: string; name: string; description: string };
  context: ContextItem[];
  task: Task;
  chatSources?: ChatSource[];
  historyMessages?: HistoryMessage[];
  projectFiles?: ProjectFile[];
  artifacts?: Artifact[];
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

  const pipeline = runEvidencePipeline({
    project: input.project,
    task: input.task,
    frozen: input.context.filter((row) => row.kind !== "RAW_HISTORY"),
    chatSources: input.chatSources ?? [],
    historyMessages: input.historyMessages ?? [],
    projectFiles: (input.projectFiles ?? []).filter((file) => (input.task.selectedFileIds ?? []).includes(file.id)),
    candidateText: candidate ? `# ${candidate.title} v${candidate.version}\n\n${candidate.content}` : null,
  });
  const coverageError = coverageBlocksCouncil(pipeline.coverage);
  if (coverageError) {
    return precheckOutput(input.task, coverageError);
  }
  if (!pipeline.pack.ok) {
    return precheckOutput(input.task, CONTEXT_BUDGET_EXCEEDED);
  }
  const ctx = pipeline.pack.text;
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

  const spend = (chars: number, maxOut: number, stage: string) => {
    const est = estimateCost(chars, maxOut);
    if (spent + est > budget) {
      throw new Error("Council stopped because the configured cost limit was reached. (" + stage + ")");
    }
    return est;
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
    const est = spend(system.length + user.length, maxTokens, `${agent} round ${round}`);
    const out = await completeChat({
      provider: input.creds.provider,
      apiKey: key,
      model: models[agent],
      messages: chat(system, user),
      maxTokens,
      temperature,
      responseFormat,
    });
    if (!out.ok) {
      return responseFromError(input.task.id, agent, round, models[agent], system, user, out.error, manifest);
    }
    spent += out.completion.cost ?? est;
    return responseFromCompletion(input.task.id, agent, round, system, user, out.completion, manifest);
  };

  try {
    input.onProgress?.({
      status: "COUNCIL_ROUND_1",
      message:
        mode === "CREATE"
          ? "Round 1 — independent analysis from GPT, Grok, and Claude."
          : "Round 1 — independent reviews from GPT, Grok, and Claude.",
    });
    const round1 = await Promise.all(AGENTS.map((agent) => ask(agent, 1, roles[agent], ctx, AGENT_MAX, 0.2)));
    responses.push(...round1);
    if (round1.some((row) => row.error)) {
      return failedOutput(input.task, responses, round1.find((row) => row.error)?.error ?? "A reviewer failed.", {
        manifest,
      });
    }

    input.onProgress?.({
      status: "COUNCIL_ROUND_2",
      message:
        mode === "CREATE"
          ? "Round 2 — cross-examination of the reconstructed architecture."
          : "Round 2 — the three reviewers are reading each other.",
    });
    const round2 = await Promise.all(
      AGENTS.map((agent) => {
        const system = `${roles[agent]}\n${ROUND2}`;
        const user = [
          ctx,
          `YOUR ROUND 1 POSITION\n${round1.find((row) => row.agent === agent)?.responseText ?? ""}`,
          `GPT ROUND 1\n${round1.find((row) => row.agent === "GPT")?.responseText ?? ""}`,
          `GROK ROUND 1\n${round1.find((row) => row.agent === "GROK")?.responseText ?? ""}`,
          `CLAUDE ROUND 1\n${round1.find((row) => row.agent === "CLAUDE")?.responseText ?? ""}`,
        ].join("\n\n");
        return ask(agent, 2, system, user, AGENT_MAX, 0.2);
      }),
    );
    responses.push(...round2);
    if (round2.some((row) => row.error)) {
      return failedOutput(input.task, responses, round2.find((row) => row.error)?.error ?? "A reviewer failed.", {
        manifest,
      });
    }

    const synthSpec = synthesisForMode(mode);
    input.onProgress?.({
      status: "SYNTHESIS",
      message:
        mode === "CREATE"
          ? "Artifact synthesis — writing the canonical document from Round 1 and Round 2."
          : "Synthesis — combining the three positions and applying the safety gate.",
    });
    const synthUser = [
      `CONTEXT MANIFEST HASH ${manifest.hash}`,
      ctx,
      ...AGENTS.map((agent) => `ROUND 2 ${agent}\n${round2.find((row) => row.agent === agent)?.responseText ?? ""}`),
    ].join("\n\n");
    const synth = await ask("GPT", 3, synthSpec.prompt, synthUser, synthSpec.max, 0, synthSpec.schema);
    responses.push(synth);
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
    const gated = applyGate(parsed, round2, mode);
    let artifact: Artifact | null = null;
    if (mode === "CREATE") {
      const drafted = parsed.artifact;
      if (!drafted) {
        return failedOutput(input.task, responses, "CREATE synthesis did not produce an artifact.", { manifest });
      }
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
        evidenceLabels: normalizeEvidenceLabels(drafted.evidenceLabels),
        createdAt: new Date().toISOString(),
      };
    }
    return completeOutput(input.task, responses, parsed, gated, { artifact, manifest });
  } catch (err) {
    const message =
      err instanceof Error && err.message.toLowerCase().includes("cost limit")
        ? "Council stopped because the configured cost limit was reached."
        : "The Council run was stopped. Check API Settings and try again.";
    return failedOutput(input.task, responses, message, { manifest });
  }
}
