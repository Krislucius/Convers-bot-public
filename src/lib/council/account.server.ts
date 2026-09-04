import { getSql } from "@/lib/db";
import { runSerialQueries } from "./hydrate";
import { maskKey, mergeStoredApiKeys, sanitizeApiKey } from "./api-key";
import { DEFAULT_CLAUDE, DEFAULT_GPT, DEFAULT_GROK, DEFAULT_MAX_COST_USD, isProviderId } from "./providers";
import type { AgentResponse, AccountSettingsPublic, Artifact, ContextItem, ContextManifest, CouncilResult, ImplementationPacket, Project, ProjectFile, StoreShape, Task } from "./types";
import type { ProviderId } from "./types";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";
import type { FileKind } from "./files";

type SettingsRow = {
  user_id: string;
  provider: string;
  openrouter_key: string;
  openrusrouter_key: string;
  gpt_model: string;
  grok_model: string;
  claude_model: string;
  max_cost_usd: unknown;
};

function asString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function asNum(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

async function durable(): Promise<void> {
  const { checkpointPglite } = await import("@/lib/db");
  await checkpointPglite();
}

function jsonParam(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function publicSettings(row: SettingsRow | null): AccountSettingsPublic {
  const provider = isProviderId(row?.provider) ? row.provider : "openrouter";
  return {
    provider,
    gptModel: row?.gpt_model?.trim() || DEFAULT_GPT,
    grokModel: row?.grok_model?.trim() || DEFAULT_GROK,
    claudeModel: row?.claude_model?.trim() || DEFAULT_CLAUDE,
    maxCostUsd: Number(row?.max_cost_usd) > 0 ? Number(row?.max_cost_usd) : DEFAULT_MAX_COST_USD,
    openrouter: {
      saved: Boolean(row?.openrouter_key),
      masked: row?.openrouter_key ? maskKey(row.openrouter_key, "openrouter") : "",
    },
    openrusrouter: {
      saved: Boolean(row?.openrusrouter_key),
      masked: row?.openrusrouter_key ? maskKey(row.openrusrouter_key, "openrusrouter") : "",
    },
  };
}

async function settingsRow(userId: string): Promise<SettingsRow | null> {
  const sql = await getSql();
  const rows = await sql<SettingsRow>`select * from account_settings where user_id = ${userId} limit 1`;
  return rows[0] ?? null;
}

export async function loadPublicSettings(userId: string): Promise<AccountSettingsPublic> {
  return publicSettings(await settingsRow(userId));
}

export async function resolveStoredKey(
  userId: string,
  provider: ProviderId,
  override = "",
): Promise<string> {
  const sanitized = sanitizeApiKey(override, provider);
  if (sanitized) return sanitized;
  const row = await settingsRow(userId);
  const stored = provider === "openrusrouter" ? row?.openrusrouter_key : row?.openrouter_key;
  return sanitizeApiKey(stored ?? "", provider);
}

export async function saveSettings(
  userId: string,
  input: {
    provider: ProviderId;
    gptModel: string;
    grokModel: string;
    claudeModel: string;
    maxCostUsd: number;
    apiKey?: string;
    clearKey?: boolean;
  },
): Promise<AccountSettingsPublic> {
  const sql = await getSql();
  const current = await settingsRow(userId);
  const provider: ProviderId = isProviderId(input.provider) ? input.provider : "openrouter";
  const merged = mergeStoredApiKeys(
    {
      openrouterKey: current?.openrouter_key ?? "",
      openrusrouterKey: current?.openrusrouter_key ?? "",
    },
    { provider, apiKey: input.apiKey, clearKey: input.clearKey },
  );
  const openrouterKey = merged.openrouterKey;
  const openrusrouterKey = merged.openrusrouterKey;
  const gptModel = input.gptModel.trim() || DEFAULT_GPT;
  const grokModel = input.grokModel.trim() || DEFAULT_GROK;
  const claudeModel = input.claudeModel.trim() || DEFAULT_CLAUDE;
  const maxCostUsd = input.maxCostUsd > 0 ? input.maxCostUsd : DEFAULT_MAX_COST_USD;
  const updatedAt = new Date().toISOString();
  await sql`
    insert into account_settings (
      user_id, provider, openrouter_key, openrusrouter_key, gpt_model, grok_model, claude_model, max_cost_usd, updated_at
    ) values (
      ${userId}, ${provider}, ${openrouterKey}, ${openrusrouterKey}, ${gptModel}, ${grokModel}, ${claudeModel}, ${maxCostUsd}, ${updatedAt}
    )
    on conflict (user_id) do update set
      provider = excluded.provider,
      openrouter_key = excluded.openrouter_key,
      openrusrouter_key = excluded.openrusrouter_key,
      gpt_model = excluded.gpt_model,
      grok_model = excluded.grok_model,
      claude_model = excluded.claude_model,
      max_cost_usd = excluded.max_cost_usd,
      updated_at = excluded.updated_at
  `;
  await durable();
  console.info("[account] saved settings", userId, provider);
  return publicSettings({
    user_id: userId,
    provider,
    openrouter_key: openrouterKey,
    openrusrouter_key: openrusrouterKey,
    gpt_model: gptModel,
    grok_model: grokModel,
    claude_model: claudeModel,
    max_cost_usd: maxCostUsd,
  });
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: asString(row.id),
    name: asString(row.name),
    description: asString(row.description),
    createdAt: asString(row.created_at),
  };
}

function mapContext(row: Record<string, unknown>): ContextItem {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    source: asString(row.source) === "IMPORT" ? "IMPORT" : "USER",
    kind: asString(row.kind) as ContextItem["kind"],
    content: asString(row.content),
    status: asString(row.status) as ContextItem["status"],
    createdAt: asString(row.created_at),
  };
}

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    title: asString(row.title),
    prompt: asString(row.prompt),
    status: asString(row.status) as Task["status"],
    error: row.error == null ? null : asString(row.error),
    createdAt: asString(row.created_at),
    completedAt: row.completed_at == null ? null : asString(row.completed_at),
    totalInputTokens: asNum(row.total_input_tokens),
    totalOutputTokens: asNum(row.total_output_tokens),
    totalCostUsd: asNum(row.total_cost_usd),
    totalLatencyMs: asNum(row.total_latency_ms),
    diagnostics: asJson(row.diagnostics, null),
    selectedChatSourceIds: asJson(row.selected_chat_source_ids, []),
    selectedFileIds: asJson(row.selected_file_ids, []),
    mode: asString(row.mode, "REVIEW") as Task["mode"],
    requiresHistoricalContext: asBool(row.requires_historical_context),
    candidateArtifactId: row.candidate_artifact_id == null ? null : asString(row.candidate_artifact_id),
    decisionQuestion: row.decision_question == null ? null : asString(row.decision_question),
    contextManifestId: row.context_manifest_id == null ? null : asString(row.context_manifest_id),
    contextHash: row.context_hash == null ? null : asString(row.context_hash),
  };
}

function mapResponse(row: Record<string, unknown>): AgentResponse {
  const structured = asJson(row.structured, null) as Record<string, string> | null;
  const runId = structured && typeof structured.__runId === "string" ? structured.__runId : null;
  const visible =
    structured == null
      ? null
      : Object.fromEntries(Object.entries(structured).filter(([key]) => key !== "__runId"));
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    agent: asString(row.agent) as AgentResponse["agent"],
    round: (asNum(row.round) ?? 1) as 1 | 2 | 3,
    model: asString(row.model),
    provider: row.provider == null ? null : asString(row.provider),
    promptSnapshot: asString(row.prompt_snapshot),
    responseText: asString(row.response_text),
    structured: visible && Object.keys(visible).length ? visible : null,
    inputTokens: asNum(row.input_tokens),
    cachedInputTokens: asNum(row.cached_input_tokens),
    outputTokens: asNum(row.output_tokens),
    reasoningTokens: asNum(row.reasoning_tokens),
    cost: asNum(row.cost),
    requestId: row.request_id == null ? null : asString(row.request_id),
    latencyMs: asNum(row.latency_ms),
    error: row.error == null ? null : asString(row.error),
    contextManifestId: row.context_manifest_id == null ? null : asString(row.context_manifest_id),
    contextHash: row.context_hash == null ? null : asString(row.context_hash),
    runId,
  };
}

function mapResult(row: Record<string, unknown>): CouncilResult {
  return {
    taskId: asString(row.task_id),
    status: asString(row.status) as CouncilResult["status"],
    consensus: asJson(row.consensus, []),
    disagreements: asJson(row.disagreements, []),
    blockers: asJson(row.blockers, []),
    recommendation: asString(row.recommendation),
    agentPositions: asJson(row.agent_positions, { gpt: "", grok: "", claude: "" }),
    synthesisRaw: row.synthesis_raw == null ? null : asString(row.synthesis_raw),
    synthesizerProposedStatus: row.synthesizer_proposed_status
      ? (asString(row.synthesizer_proposed_status) as CouncilResult["status"])
      : null,
    finalEnforcedStatus: row.final_enforced_status
      ? (asString(row.final_enforced_status) as CouncilResult["status"])
      : null,
    verdictOverride: asBool(row.verdict_override),
    overrideReason: row.override_reason == null ? null : asString(row.override_reason),
    decision: row.decision == null ? null : asString(row.decision),
    rationale: row.rationale == null ? null : asString(row.rationale),
    dissent: asJson(row.dissent, []),
    reviewVerdict: (row.review_verdict ? asString(row.review_verdict) : asJson(row.structured, {} as Record<string, unknown>).reviewVerdict ?? null) as CouncilResult["reviewVerdict"],
    alternatives: asJson(asJson(row.structured, {} as Record<string, unknown>).alternatives, []),
    evidence: asJson(asJson(row.structured, {} as Record<string, unknown>).evidence, []),
    risks: asJson(asJson(row.structured, {} as Record<string, unknown>).risks, []),
    issues: asJson(asJson(row.structured, {} as Record<string, unknown>).issues, []),
    proposedCorrections: asJson(asJson(row.structured, {} as Record<string, unknown>).proposedCorrections, []),
    resolvedIssues: asJson(asJson(row.structured, {} as Record<string, unknown>).resolvedIssues, []),
    unresolvedIssues: asJson(asJson(row.structured, {} as Record<string, unknown>).unresolvedIssues, []),
    citations: asJson(asJson(row.structured, {} as Record<string, unknown>).citations, []),
    failedAgents: asJson(asJson(row.structured, {} as Record<string, unknown>).failedAgents, []),
  };
}

function mapChat(row: Record<string, unknown>): ChatSource {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    provider: asString(row.provider) as ChatSource["provider"],
    title: asString(row.title),
    sourceUrl: row.source_url == null ? null : asString(row.source_url),
    importMethod: asString(row.import_method) as ChatSource["importMethod"],
    accessStatus: asString(row.access_status) as ChatSource["accessStatus"],
    importStatus: asString(row.import_status) as ChatSource["importStatus"],
    rawContent: asString(row.raw_content),
    messageCount: asNum(row.message_count),
    characterCount: asNum(row.character_count) ?? 0,
    estimatedTokenCount: asNum(row.estimated_token_count),
    contentHash: asString(row.content_hash),
    createdAt: asString(row.created_at),
    importedAt: row.imported_at == null ? null : asString(row.imported_at),
    lastAccessCheckAt: row.last_access_check_at == null ? null : asString(row.last_access_check_at),
    lastError: row.last_error == null ? null : asString(row.last_error),
    includeInMemory: asBool(row.include_in_memory),
  };
}

function mapFile(row: Record<string, unknown>): ProjectFile {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    filename: asString(row.filename),
    kind: asString(row.kind) as FileKind,
    extractedText: asString(row.extracted_text),
    members: asJson(row.members, []),
    notes: asString(row.notes),
    sizeBytes: asNum(row.size_bytes) ?? 0,
    characterCount: asNum(row.character_count) ?? 0,
    estimatedTokens: asNum(row.estimated_tokens) ?? 0,
    includeInMemory: asBool(row.include_in_memory),
    createdAt: asString(row.created_at),
  };
}

function mapMessage(row: Record<string, unknown>): HistoryMessage {
  return {
    id: asString(row.id),
    chatSourceId: asString(row.chat_source_id),
    sequence: asNum(row.sequence) ?? 0,
    speaker: asString(row.speaker),
    role: asString(row.role) as HistoryMessage["role"],
    content: asString(row.content),
    timestamp: row.timestamp == null ? null : asString(row.timestamp),
  };
}

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    taskId: asString(row.task_id),
    type: asString(row.type) as Artifact["type"],
    title: asString(row.title),
    version: asString(row.version),
    content: asString(row.content),
    status: asString(row.status) as Artifact["status"],
    contextHash: asString(row.context_hash),
    evidenceLabels: asJson(row.evidence_labels, []),
    createdAt: asString(row.created_at),
  };
}

function mapManifest(row: Record<string, unknown>): ContextManifest {
  return {
    id: asString(row.id),
    taskId: asString(row.task_id),
    hash: asString(row.hash),
    payload: asJson(row.payload, {
      project: { id: "", name: "", description: "" },
      task: {
        id: "",
        title: "",
        prompt: "",
        mode: "REVIEW",
        requiresHistoricalContext: false,
        candidateArtifactId: null,
        decisionQuestion: null,
      },
      selectedAiChats: [],
      selectedFiles: [],
      activeDecisions: [],
      frozenInvariants: [],
      activeSpecifications: [],
      projectState: [],
      candidateArtifact: null,
      evidence: null,
    }),
    createdAt: asString(row.created_at),
  };
}

function mapPacket(row: Record<string, unknown>): ImplementationPacket {
  return {
    id: asString(row.id),
    projectId: asString(row.project_id),
    taskId: asString(row.task_id),
    artifactId: asString(row.artifact_id),
    parentPacketId: row.parent_packet_id == null ? null : asString(row.parent_packet_id),
    iteration: asNum(row.iteration) ?? 1,
    status: asString(row.status) as ImplementationPacket["status"],
    scope: asString(row.scope),
    requirements: asJson(row.requirements, []),
    invariants: asJson(row.invariants, []),
    evidenceRefs: asJson(row.evidence_refs, []),
    acceptanceTests: asJson(row.acceptance_tests, []),
    blockers: asJson(row.blockers, []),
    packetHash: asString(row.packet_hash),
    handoffAt: row.handoff_at == null ? null : asString(row.handoff_at),
    implementationStatus: row.implementation_status == null ? null : (asString(row.implementation_status) as ImplementationPacket["implementationStatus"]),
    implementationNotes: row.implementation_notes == null ? null : asString(row.implementation_notes),
    implementationRecordedAt: row.implementation_recorded_at == null ? null : asString(row.implementation_recorded_at),
    reviewTaskId: row.review_task_id == null ? null : asString(row.review_task_id),
    createdAt: asString(row.created_at),
  };
}

export async function loadSnapshot(userId: string): Promise<StoreShape> {
  const sql = await getSql();
  const projects = await sql`select * from projects where user_id = ${userId} order by created_at desc`;
  if (projects.length === 0) {
    return {
      projects: [],
      context: [],
      tasks: [],
      responses: [],
      results: [],
      chatSources: [],
      historyMessages: [],
      projectFiles: [],
      artifacts: [],
      manifests: [],
      packets: [],
    };
  }
  const [context, tasks, responses, results, chatSources, historyMessages, artifacts, manifests] =
    await runSerialQueries([
      () => sql`select * from context_items where user_id = ${userId} order by created_at`,
      () => sql`select * from tasks where user_id = ${userId} order by created_at desc`,
      () => sql`select * from agent_responses where user_id = ${userId}`,
      () => sql`select * from council_results where user_id = ${userId}`,
      () => sql`select * from chat_sources where user_id = ${userId} order by created_at desc`,
      () => sql`select * from history_messages where user_id = ${userId} order by sequence`,
      () => sql`select * from artifacts where user_id = ${userId} order by created_at desc`,
      () => sql`select * from context_manifests where user_id = ${userId} order by created_at desc`,
    ]);
  let projectFiles: Record<string, unknown>[] = [];
  try {
    projectFiles = await sql`select * from project_files where user_id = ${userId} order by created_at desc`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/project_files|does not exist|undefined_table/i.test(message)) throw err;
  }
  let packets: Record<string, unknown>[] = [];
  try {
    packets = await sql`select * from implementation_packets where user_id = ${userId} order by created_at desc`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/implementation_packets|does not exist|undefined_table/i.test(message)) throw err;
  }
  return {
    projects: projects.map(mapProject),
    context: context.map(mapContext),
    tasks: tasks.map(mapTask),
    responses: responses.map(mapResponse),
    results: results.map(mapResult),
    chatSources: chatSources.map(mapChat),
    historyMessages: historyMessages.map(mapMessage),
    projectFiles: projectFiles.map(mapFile),
    artifacts: artifacts.map(mapArtifact),
    manifests: manifests.map(mapManifest),
    packets: packets.map(mapPacket),
  };
}

export async function loadHydrate(userId: string): Promise<{ snapshot: StoreShape; settings: AccountSettingsPublic }> {
  const settings = await loadPublicSettings(userId);
  const snapshot = await loadSnapshot(userId);
  return { snapshot, settings };
}

async function insertProjectRow(userId: string, project: Project) {
  const sql = await getSql();
  await sql`
    insert into projects (id, user_id, name, description, created_at)
    values (${project.id}, ${userId}, ${project.name}, ${project.description}, ${project.createdAt})
    on conflict (id) do update set
      name = excluded.name,
      description = excluded.description
    where projects.user_id = ${userId}
  `;
}

async function insertContextRow(userId: string, item: ContextItem) {
  const sql = await getSql();
  await sql`
    insert into context_items (id, user_id, project_id, source, kind, content, status, created_at)
    values (${item.id}, ${userId}, ${item.projectId}, ${item.source}, ${item.kind}, ${item.content}, ${item.status}, ${item.createdAt})
    on conflict (id) do update set
      content = excluded.content,
      status = excluded.status
    where context_items.user_id = ${userId}
  `;
}

async function insertTaskRow(userId: string, task: Task) {
  const sql = await getSql();
  await sql`
    insert into tasks (
      id, user_id, project_id, title, prompt, status, error, created_at, completed_at,
      total_input_tokens, total_output_tokens, total_cost_usd, total_latency_ms, diagnostics, selected_chat_source_ids,
      selected_file_ids, mode, requires_historical_context, candidate_artifact_id, decision_question, context_manifest_id, context_hash
    ) values (
      ${task.id}, ${userId}, ${task.projectId}, ${task.title}, ${task.prompt}, ${task.status}, ${task.error},
      ${task.createdAt}, ${task.completedAt}, ${task.totalInputTokens}, ${task.totalOutputTokens}, ${task.totalCostUsd},
      ${task.totalLatencyMs}, ${jsonParam(task.diagnostics)}::jsonb, ${jsonParam(task.selectedChatSourceIds) ?? "[]"}::jsonb,
      ${jsonParam(task.selectedFileIds) ?? "[]"}::jsonb, ${task.mode}, ${task.requiresHistoricalContext}, ${task.candidateArtifactId}, ${task.decisionQuestion},
      ${task.contextManifestId}, ${task.contextHash}
    )
    on conflict (id) do update set
      title = excluded.title,
      prompt = excluded.prompt,
      status = excluded.status,
      error = excluded.error,
      completed_at = excluded.completed_at,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cost_usd = excluded.total_cost_usd,
      total_latency_ms = excluded.total_latency_ms,
      diagnostics = excluded.diagnostics,
      selected_chat_source_ids = excluded.selected_chat_source_ids,
      selected_file_ids = excluded.selected_file_ids,
      mode = excluded.mode,
      requires_historical_context = excluded.requires_historical_context,
      candidate_artifact_id = excluded.candidate_artifact_id,
      decision_question = excluded.decision_question,
      context_manifest_id = excluded.context_manifest_id,
      context_hash = excluded.context_hash
    where tasks.user_id = ${userId}
  `;
}

async function insertResponseRow(userId: string, row: AgentResponse) {
  const sql = await getSql();
  await sql`
    insert into agent_responses (
      id, user_id, task_id, agent, round, model, provider, prompt_snapshot, response_text, structured,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, cost, request_id, latency_ms, error,
      context_manifest_id, context_hash
    ) values (
      ${row.id}, ${userId}, ${row.taskId}, ${row.agent}, ${row.round}, ${row.model}, ${row.provider},
      ${row.promptSnapshot}, ${row.responseText}, ${jsonParam(row.structured)}::jsonb,
      ${row.inputTokens}, ${row.cachedInputTokens}, ${row.outputTokens}, ${row.reasoningTokens},
      ${row.cost}, ${row.requestId}, ${row.latencyMs}, ${row.error},
      ${row.contextManifestId}, ${row.contextHash}
    )
    on conflict (id) do update set
      response_text = excluded.response_text,
      error = excluded.error
    where agent_responses.user_id = ${userId}
  `;
}

async function insertResultRow(userId: string, result: CouncilResult) {
  const sql = await getSql();
  await sql`
    insert into council_results (
      task_id, user_id, status, consensus, disagreements, blockers, recommendation, agent_positions,
      synthesis_raw, synthesizer_proposed_status, final_enforced_status, verdict_override, override_reason,
      decision, rationale, dissent, review_verdict, structured
    ) values (
      ${result.taskId}, ${userId}, ${result.status}, ${jsonParam(result.consensus) ?? "[]"}::jsonb,
      ${jsonParam(result.disagreements) ?? "[]"}::jsonb, ${jsonParam(result.blockers) ?? "[]"}::jsonb,
      ${result.recommendation}, ${jsonParam(result.agentPositions) ?? "{}"}::jsonb, ${result.synthesisRaw},
      ${result.synthesizerProposedStatus}, ${result.finalEnforcedStatus}, ${result.verdictOverride}, ${result.overrideReason},
      ${result.decision}, ${result.rationale}, ${jsonParam(result.dissent) ?? "[]"}::jsonb,
      ${result.reviewVerdict},
      ${jsonParam({
        alternatives: result.alternatives,
        evidence: result.evidence,
        risks: result.risks,
        issues: result.issues,
        proposedCorrections: result.proposedCorrections,
        resolvedIssues: result.resolvedIssues,
        unresolvedIssues: result.unresolvedIssues,
        citations: result.citations,
        failedAgents: result.failedAgents,
        reviewVerdict: result.reviewVerdict,
      }) ?? "{}"}::jsonb
    )
    on conflict (task_id) do update set
      status = excluded.status,
      consensus = excluded.consensus,
      disagreements = excluded.disagreements,
      blockers = excluded.blockers,
      recommendation = excluded.recommendation,
      agent_positions = excluded.agent_positions,
      synthesis_raw = excluded.synthesis_raw,
      synthesizer_proposed_status = excluded.synthesizer_proposed_status,
      final_enforced_status = excluded.final_enforced_status,
      verdict_override = excluded.verdict_override,
      override_reason = excluded.override_reason,
      decision = excluded.decision,
      rationale = excluded.rationale,
      dissent = excluded.dissent,
      review_verdict = excluded.review_verdict,
      structured = excluded.structured
    where council_results.user_id = ${userId}
  `;
}

async function insertChatRow(userId: string, source: ChatSource) {
  const sql = await getSql();
  await sql`
    insert into chat_sources (
      id, user_id, project_id, provider, title, source_url, import_method, access_status, import_status,
      raw_content, message_count, character_count, estimated_token_count, content_hash, created_at, imported_at,
      last_access_check_at, last_error, include_in_memory
    ) values (
      ${source.id}, ${userId}, ${source.projectId}, ${source.provider}, ${source.title}, ${source.sourceUrl},
      ${source.importMethod}, ${source.accessStatus}, ${source.importStatus}, ${source.rawContent},
      ${source.messageCount}, ${source.characterCount}, ${source.estimatedTokenCount}, ${source.contentHash},
      ${source.createdAt}, ${source.importedAt}, ${source.lastAccessCheckAt}, ${source.lastError}, ${source.includeInMemory}
    )
    on conflict (id) do update set
      title = excluded.title,
      access_status = excluded.access_status,
      import_status = excluded.import_status,
      raw_content = excluded.raw_content,
      message_count = excluded.message_count,
      character_count = excluded.character_count,
      estimated_token_count = excluded.estimated_token_count,
      content_hash = excluded.content_hash,
      imported_at = excluded.imported_at,
      last_access_check_at = excluded.last_access_check_at,
      last_error = excluded.last_error,
      include_in_memory = excluded.include_in_memory
    where chat_sources.user_id = ${userId}
  `;
}

async function insertMessageRows(userId: string, messages: HistoryMessage[]) {
  const sql = await getSql();
  for (const row of messages) {
    await sql`
      insert into history_messages (id, user_id, chat_source_id, sequence, speaker, role, content, timestamp)
      values (${row.id}, ${userId}, ${row.chatSourceId}, ${row.sequence}, ${row.speaker}, ${row.role}, ${row.content}, ${row.timestamp})
      on conflict (id) do update set
        content = excluded.content,
        speaker = excluded.speaker,
        role = excluded.role
      where history_messages.user_id = ${userId}
    `;
  }
}

async function insertArtifactRow(userId: string, artifact: Artifact) {
  const sql = await getSql();
  await sql`
    insert into artifacts (
      id, user_id, task_id, project_id, type, title, version, content, status, context_hash, evidence_labels, created_at
    ) values (
      ${artifact.id}, ${userId}, ${artifact.taskId}, ${artifact.projectId}, ${artifact.type}, ${artifact.title},
      ${artifact.version}, ${artifact.content}, ${artifact.status}, ${artifact.contextHash},
      ${jsonParam(artifact.evidenceLabels) ?? "[]"}::jsonb, ${artifact.createdAt}
    )
    on conflict (id) do update set
      title = excluded.title,
      version = excluded.version,
      content = excluded.content,
      status = excluded.status,
      context_hash = excluded.context_hash,
      evidence_labels = excluded.evidence_labels
    where artifacts.user_id = ${userId}
  `;
}

async function insertManifestRow(userId: string, manifest: ContextManifest) {
  const sql = await getSql();
  await sql`
    insert into context_manifests (id, user_id, task_id, hash, payload, created_at)
    values (
      ${manifest.id}, ${userId}, ${manifest.taskId}, ${manifest.hash},
      ${jsonParam(manifest.payload) ?? "{}"}::jsonb, ${manifest.createdAt}
    )
    on conflict (id) do update set
      hash = excluded.hash,
      payload = excluded.payload
    where context_manifests.user_id = ${userId}
  `;
}

async function insertPacketRow(userId: string, packet: ImplementationPacket) {
  const sql = await getSql();
  await sql`
    insert into implementation_packets (
      id, user_id, project_id, task_id, artifact_id, parent_packet_id, iteration, status, scope,
      requirements, invariants, evidence_refs, acceptance_tests, blockers, packet_hash, handoff_at,
      implementation_status, implementation_notes, implementation_recorded_at, review_task_id, created_at
    ) values (
      ${packet.id}, ${userId}, ${packet.projectId}, ${packet.taskId}, ${packet.artifactId}, ${packet.parentPacketId},
      ${packet.iteration}, ${packet.status}, ${packet.scope},
      ${jsonParam(packet.requirements) ?? "[]"}::jsonb, ${jsonParam(packet.invariants) ?? "[]"}::jsonb,
      ${jsonParam(packet.evidenceRefs) ?? "[]"}::jsonb, ${jsonParam(packet.acceptanceTests) ?? "[]"}::jsonb,
      ${jsonParam(packet.blockers) ?? "[]"}::jsonb, ${packet.packetHash}, ${packet.handoffAt},
      ${packet.implementationStatus}, ${packet.implementationNotes}, ${packet.implementationRecordedAt},
      ${packet.reviewTaskId}, ${packet.createdAt}
    )
    on conflict (id) do update set
      status = excluded.status,
      scope = excluded.scope,
      requirements = excluded.requirements,
      invariants = excluded.invariants,
      evidence_refs = excluded.evidence_refs,
      acceptance_tests = excluded.acceptance_tests,
      blockers = excluded.blockers,
      packet_hash = excluded.packet_hash,
      handoff_at = excluded.handoff_at,
      implementation_status = excluded.implementation_status,
      implementation_notes = excluded.implementation_notes,
      implementation_recorded_at = excluded.implementation_recorded_at,
      review_task_id = excluded.review_task_id
    where implementation_packets.user_id = ${userId}
  `;
}

export async function writeSnapshot(userId: string, snapshot: StoreShape): Promise<void> {
  const sql = await getSql();
  await sql`delete from history_messages where user_id = ${userId}`;
  await sql`delete from chat_sources where user_id = ${userId}`;
  await sql`delete from project_files where user_id = ${userId}`;
  await sql`delete from agent_responses where user_id = ${userId}`;
  await sql`delete from council_results where user_id = ${userId}`;
  await sql`delete from artifacts where user_id = ${userId}`;
  await sql`delete from context_manifests where user_id = ${userId}`;
  try {
    await sql`delete from implementation_packets where user_id = ${userId}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/implementation_packets|does not exist|undefined_table/i.test(message)) throw err;
  }
  await sql`delete from tasks where user_id = ${userId}`;
  await sql`delete from context_items where user_id = ${userId}`;
  await sql`delete from projects where user_id = ${userId}`;
  for (const project of snapshot.projects) await insertProjectRow(userId, project);
  for (const item of snapshot.context) await insertContextRow(userId, item);
  for (const task of snapshot.tasks) await insertTaskRow(userId, task);
  for (const row of snapshot.responses) await insertResponseRow(userId, row);
  for (const result of snapshot.results) await insertResultRow(userId, result);
  for (const source of snapshot.chatSources) await insertChatRow(userId, source);
  await insertMessageRows(userId, snapshot.historyMessages);
  for (const file of snapshot.projectFiles ?? []) await insertFileRow(userId, file);
  for (const artifact of snapshot.artifacts ?? []) await insertArtifactRow(userId, artifact);
  for (const manifest of snapshot.manifests ?? []) await insertManifestRow(userId, manifest);
  for (const packet of snapshot.packets ?? []) await insertPacketRow(userId, packet);
  await durable();
}

export async function importSnapshotIfEmpty(userId: string, snapshot: StoreShape): Promise<StoreShape> {
  const existing = await loadSnapshot(userId);
  if (existing.projects.length > 0) return existing;
  if (!snapshot.projects.length) return existing;
  await writeSnapshot(userId, snapshot);
  return snapshot;
}

export async function persistProject(userId: string, project: Project) {
  await insertProjectRow(userId, project);
  await durable();
  console.info("[account] persisted project", userId, project.id);
}

export async function persistContext(userId: string, item: ContextItem) {
  await insertContextRow(userId, item);
  await durable();
}

export async function persistTask(userId: string, task: Task) {
  await insertTaskRow(userId, task);
  await durable();
}

export async function persistManifest(userId: string, manifest: ContextManifest) {
  await insertManifestRow(userId, manifest);
  await durable();
}

export async function persistCouncilOutput(
  userId: string,
  patch: {
    task: Task;
    responses: AgentResponse[];
    result: CouncilResult | null;
    artifact?: Artifact | null;
    manifest?: ContextManifest | null;
    packet?: ImplementationPacket | null;
    artifacts?: Artifact[];
  },
) {
  const sql = await getSql();
  await insertTaskRow(userId, patch.task);
  await sql`delete from agent_responses where user_id = ${userId} and task_id = ${patch.task.id}`;
  for (const row of patch.responses) await insertResponseRow(userId, row);
  if (patch.result) await insertResultRow(userId, patch.result);
  else await sql`delete from council_results where user_id = ${userId} and task_id = ${patch.task.id}`;
  if (patch.manifest) await insertManifestRow(userId, patch.manifest);
  if (patch.artifact) await insertArtifactRow(userId, patch.artifact);
  if (patch.artifacts) {
    for (const artifact of patch.artifacts) await insertArtifactRow(userId, artifact);
  }
  if (patch.packet) await insertPacketRow(userId, patch.packet);
  await durable();
}

export async function persistPacket(userId: string, packet: ImplementationPacket) {
  await insertPacketRow(userId, packet);
  await durable();
}

export async function persistChat(
  userId: string,
  source: ChatSource,
  messages: HistoryMessage[],
  replaceMessages: boolean,
) {
  const sql = await getSql();
  await insertChatRow(userId, source);
  if (replaceMessages) {
    await sql`delete from history_messages where user_id = ${userId} and chat_source_id = ${source.id}`;
  }
  await insertMessageRows(
    userId,
    messages.map((row) => ({ ...row, chatSourceId: source.id })),
  );
  await durable();
}

export async function persistChatPatch(userId: string, source: ChatSource) {
  await insertChatRow(userId, source);
  await durable();
}

export async function persistDeleteChat(userId: string, chatId: string, tasks: Task[]) {
  const sql = await getSql();
  await sql`delete from history_messages where user_id = ${userId} and chat_source_id = ${chatId}`;
  await sql`delete from chat_sources where user_id = ${userId} and id = ${chatId}`;
  for (const task of tasks) await insertTaskRow(userId, task);
  await durable();
}

async function insertFileRow(userId: string, file: ProjectFile) {
  const sql = await getSql();
  await sql`
    insert into project_files (
      id, user_id, project_id, filename, kind, extracted_text, members, notes, size_bytes,
      character_count, estimated_tokens, include_in_memory, created_at
    ) values (
      ${file.id}, ${userId}, ${file.projectId}, ${file.filename}, ${file.kind}, ${file.extractedText},
      ${jsonParam(file.members) ?? "[]"}::jsonb, ${file.notes}, ${file.sizeBytes}, ${file.characterCount},
      ${file.estimatedTokens}, ${file.includeInMemory}, ${file.createdAt}
    )
    on conflict (id) do update set
      filename = excluded.filename,
      kind = excluded.kind,
      extracted_text = excluded.extracted_text,
      members = excluded.members,
      notes = excluded.notes,
      size_bytes = excluded.size_bytes,
      character_count = excluded.character_count,
      estimated_tokens = excluded.estimated_tokens,
      include_in_memory = excluded.include_in_memory
    where project_files.user_id = ${userId}
  `;
}

export async function persistFile(userId: string, file: ProjectFile) {
  await insertFileRow(userId, file);
  await durable();
}

export async function persistDeleteFile(userId: string, fileId: string, tasks: Task[]) {
  const sql = await getSql();
  await sql`delete from project_files where user_id = ${userId} and id = ${fileId}`;
  for (const task of tasks) await insertTaskRow(userId, task);
  await durable();
}

export async function ownedProjectId(userId: string, projectId: string): Promise<string | null> {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`select id from projects where user_id = ${userId} and id = ${projectId} limit 1`;
  return rows[0]?.id ?? null;
}

export async function ownedChat(userId: string, chatId: string): Promise<ChatSource | null> {
  const sql = await getSql();
  const rows = await sql`select * from chat_sources where user_id = ${userId} and id = ${chatId} limit 1`;
  return rows[0] ? mapChat(rows[0]) : null;
}
