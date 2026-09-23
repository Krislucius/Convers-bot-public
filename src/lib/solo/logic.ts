import { countTokens } from "../evidence/tokens.ts";
import { hashContent } from "../history/hash.ts";
import { classifyFileSource, scrubSourceContradictions, type FileSourceState } from "../evidence/source-state.ts";
import type { ProjectFile, ProviderId } from "../council/types.ts";

export type WorkMode = "SOLO" | "COUNCIL";
export type SoloRole = "USER" | "ASSISTANT" | "CONTEXT" | "TRANSITION";
export const SOLO_CALLS = "SOLO_CALLS" as const;
export const COUNCIL_CALLS = "COUNCIL_CALLS" as const;

export type SoloMessage = {
  id: string;
  threadId: string;
  role: SoloRole;
  content: string;
  provider: string | null;
  modelId: string | null;
  createdAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  latencyMs: number | null;
  error: string | null;
  citations: string[];
  stopped: boolean;
};

export type SoloTransition = {
  fromProvider: string;
  fromModelId: string;
  toProvider: string;
  toModelId: string;
  at: string;
};

export type SoloThread = {
  id: string;
  projectId: string;
  provider: ProviderId;
  modelId: string;
  modelLabel: string;
  title: string;
  contextEnabled: boolean;
  selectedChatIds: string[];
  selectedFileIds: string[];
  selectedArtifactIds: string[];
  createdAt: string;
  updatedAt: string;
  messages: SoloMessage[];
  transitions: SoloTransition[];
};

export type SoloContextInput = {
  instructions?: string;
  chats?: Array<{ id: string; title: string; text: string }>;
  files?: Array<Pick<ProjectFile, "id" | "filename" | "kind" | "extractedText" | "notes" | "characterCount"> & Partial<Pick<ProjectFile, "sourceStatus" | "sourceLanguage" | "pageCount" | "chunkCount" | "extractionMethod" | "sourceHash">>>;
  artifacts?: Array<{ id: string; title: string; content: string }>;
  repositoryLines?: string[];
};

const SYSTEM = [
  "You are one model in Solo mode.",
  "You are not a Council. Do not invent members, rounds, synthesis, or a verdict.",
  "Answer in the language the user wrote. Do not translate their message before answering.",
  "Project context below is optional evidence. If SOURCE_STATUS=EXTRACTED, the extracted text is included. Do not claim that file is unreadable or that PDF text is unavailable.",
  "When the user asks for a source-grounded answer, cite sources as [chat:ID] or [file:ID].",
].join(" ");

export function projectWorkMode(mode: string | null | undefined): WorkMode {
  return mode === "SOLO" ? "SOLO" : "COUNCIL";
}

export function createSoloThread(input: {
  id: string;
  projectId: string;
  provider: ProviderId;
  modelId: string;
  modelLabel?: string;
  title?: string;
  now: string;
  contextText?: string;
}): SoloThread {
  const thread: SoloThread = {
    id: input.id,
    projectId: input.projectId,
    provider: input.provider,
    modelId: input.modelId,
    modelLabel: input.modelLabel?.trim() || input.modelId,
    title: input.title?.trim() || "Solo",
    contextEnabled: Boolean(input.contextText?.trim()),
    selectedChatIds: [],
    selectedFileIds: [],
    selectedArtifactIds: [],
    createdAt: input.now,
    updatedAt: input.now,
    messages: [],
    transitions: [],
  };
  if (input.contextText?.trim()) {
    thread.messages.push(message(thread, "CONTEXT", input.contextText.trim(), input.now, input.provider, input.modelId));
  }
  return thread;
}

function message(
  thread: SoloThread,
  role: SoloRole,
  content: string,
  now: string,
  provider: string | null,
  modelId: string | null,
): SoloMessage {
  return {
    id: `sm_${hashContent(`${thread.id}:${role}:${now}:${content}`).slice(0, 24)}`,
    threadId: thread.id,
    role,
    content,
    provider,
    modelId,
    createdAt: now,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    latencyMs: null,
    error: null,
    citations: extractCitations(content),
    stopped: false,
  };
}

export function extractCitations(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(?:chat|file):[^\]]+\]/g)].map((row) => row[0]))];
}

export function buildContextPack(thread: SoloThread, input: SoloContextInput): { text: string; tokens: number; chats: number; files: number; states: FileSourceState[] } {
  if (!thread.contextEnabled) return { text: "", tokens: 0, chats: 0, files: 0, states: [] };
  const chats = (input.chats ?? []).filter((row) => thread.selectedChatIds.includes(row.id));
  const files = (input.files ?? []).filter((row) => thread.selectedFileIds.includes(row.id));
  const artifacts = (input.artifacts ?? []).filter((row) => thread.selectedArtifactIds.includes(row.id));
  const states = files.map((file) => classifyFileSource(file)).sort((a, b) => a.fileId.localeCompare(b.fileId));
  const lines = [
    input.instructions?.trim() ? `PROJECT INSTRUCTIONS\n${input.instructions.trim()}` : "",
    ...chats.map((row) => `CHAT ${row.id} ${row.title}\n${row.text}`),
    ...states.map((state) => {
      const file = files.find((row) => row.id === state.fileId);
      const body = state.sourceStatus === "EXTRACTED" ? file?.extractedText ?? "" : `[not included: SOURCE_STATUS=${state.sourceStatus}]`;
      return `FILE ${state.fileId} ${state.filename} SOURCE_STATUS=${state.sourceStatus} language=${state.language}\n${body}`;
    }),
    ...(input.repositoryLines ?? []).map((row) => `REPOSITORY ${row}`),
    ...artifacts.map((row) => `ARTIFACT ${row.id} ${row.title}\n${row.content}`),
  ].filter(Boolean);
  const text = lines.join("\n\n");
  return { text, tokens: countTokens(text), chats: chats.length, files: files.length, states };
}

export function modelMessages(thread: SoloThread, packText: string): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const system = [SYSTEM, packText ? `\n\nPROJECT CONTEXT\n${packText}` : ""].join("");
  const out: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: system }];
  for (const row of thread.messages) {
    if (row.role === "CONTEXT") {
      out.push({ role: "system", content: `ATTACHED CONTEXT\n${row.content}` });
    } else if (row.role === "TRANSITION") {
      out.push({ role: "system", content: row.content });
    } else if (row.role === "USER") {
      out.push({ role: "user", content: row.content });
    } else if (row.role === "ASSISTANT" && !row.error) {
      out.push({ role: "assistant", content: row.content });
    }
  }
  return out;
}

export function planModelChange(thread: SoloThread, next: { provider: ProviderId; modelId: string }): { needsConfirm: boolean } {
  return { needsConfirm: next.provider !== thread.provider || next.modelId !== thread.modelId };
}

export function applyModelChange(
  thread: SoloThread,
  next: { provider: ProviderId; modelId: string; modelLabel?: string },
  now: string,
  confirmed: boolean,
): SoloThread {
  if (!confirmed) return thread;
  if (!planModelChange(thread, next).needsConfirm) return thread;
  const transition: SoloTransition = {
    fromProvider: thread.provider,
    fromModelId: thread.modelId,
    toProvider: next.provider,
    toModelId: next.modelId,
    at: now,
  };
  const note = message(
    thread,
    "TRANSITION",
    `MODEL TRANSITION ${transition.fromProvider}/${transition.fromModelId} -> ${transition.toProvider}/${transition.toModelId} at ${now}. Continue the same conversation. Do not pretend to be the previous model.`,
    now,
    next.provider,
    next.modelId,
  );
  return {
    ...thread,
    provider: next.provider,
    modelId: next.modelId,
    modelLabel: next.modelLabel?.trim() || next.modelId,
    updatedAt: now,
    transitions: [...thread.transitions, transition],
    messages: [...thread.messages, note],
  };
}

export function withUserMessage(thread: SoloThread, content: string, now: string): SoloThread {
  const text = content.trim();
  if (!text) return thread;
  return {
    ...thread,
    title: thread.messages.some((row) => row.role === "USER") ? thread.title : text.slice(0, 80),
    updatedAt: now,
    messages: [...thread.messages, message(thread, "USER", text, now, thread.provider, thread.modelId)],
  };
}

export function withAssistantMessage(
  thread: SoloThread,
  input: { content: string; now: string; error?: string | null; usage?: { inputTokens?: number | null; outputTokens?: number | null; cost?: number | null; latencyMs?: number | null }; stopped?: boolean; states?: FileSourceState[] },
): SoloThread {
  const scrubbed = scrubSourceContradictions(input.content, input.states ?? []);
  const row = message(thread, "ASSISTANT", scrubbed.text, input.now, thread.provider, thread.modelId);
  row.error = input.error ?? null;
  row.stopped = Boolean(input.stopped);
  row.inputTokens = input.usage?.inputTokens ?? null;
  row.outputTokens = input.usage?.outputTokens ?? null;
  row.cost = input.usage?.cost ?? null;
  row.latencyMs = input.usage?.latencyMs ?? null;
  row.citations = extractCitations(row.content);
  return { ...thread, updatedAt: input.now, messages: [...thread.messages, row] };
}

export function stopLastAssistant(thread: SoloThread, partial: string): SoloThread {
  const index = [...thread.messages].reverse().findIndex((row) => row.role === "ASSISTANT");
  if (index < 0) return thread;
  const at = thread.messages.length - 1 - index;
  const messages = thread.messages.map((row, i) => (i === at ? { ...row, content: partial, stopped: true, citations: extractCitations(partial) } : row));
  return { ...thread, messages };
}

export function dropLastAssistant(thread: SoloThread): SoloThread {
  const index = [...thread.messages].reverse().findIndex((row) => row.role === "ASSISTANT");
  if (index < 0) return thread;
  const at = thread.messages.length - 1 - index;
  return { ...thread, messages: thread.messages.filter((_, i) => i !== at) };
}

export function resumeThread(raw: SoloThread): SoloThread {
  return {
    ...raw,
    messages: raw.messages.map((row) => ({ ...row, citations: row.citations ?? extractCitations(row.content) })),
    transitions: raw.transitions ?? [],
    selectedChatIds: raw.selectedChatIds ?? [],
    selectedFileIds: raw.selectedFileIds ?? [],
    selectedArtifactIds: raw.selectedArtifactIds ?? [],
  };
}

export type SoloHandoff = {
  provenance: "SOLO_THREAD";
  soloThreadId: string;
  provider: string;
  modelId: string;
  messageIds: string[];
  timestamp: string;
  snapshotHash: string;
  text: string;
};

export function handoffSnapshot(thread: SoloThread, messageIds: string[] | "ALL" | "LAST", now: string): SoloHandoff {
  const pool = thread.messages.filter((row) => row.role === "USER" || row.role === "ASSISTANT");
  const chosen =
    messageIds === "ALL" ? pool : messageIds === "LAST" ? pool.filter((row) => row.role === "ASSISTANT").slice(-1) : pool.filter((row) => messageIds.includes(row.id));
  const body = chosen.map((row) => `${row.createdAt} ${row.role} ${row.modelId ?? ""}\n${row.content}`).join("\n\n");
  const ids = chosen.map((row) => row.id);
  const identity = { provenance: "SOLO_THREAD", soloThreadId: thread.id, provider: thread.provider, modelId: thread.modelId, messageIds: ids, body };
  const snapshotHash = hashContent(JSON.stringify(identity));
  const text = [
    "SOLO_THREAD",
    `provider: ${thread.provider}`,
    `model_id: ${thread.modelId}`,
    `message_ids: ${ids.join(",")}`,
    `timestamp: ${now}`,
    `snapshot_hash: ${snapshotHash}`,
    "",
    "This transcript is evidence, not a canonical decision.",
    "",
    body,
  ].join("\n");
  return {
    provenance: "SOLO_THREAD",
    soloThreadId: thread.id,
    provider: thread.provider,
    modelId: thread.modelId,
    messageIds: ids,
    timestamp: now,
    snapshotHash,
    text,
  };
}

export function seedFromCouncil(input: {
  id: string;
  projectId: string;
  provider: ProviderId;
  modelId: string;
  modelLabel?: string;
  now: string;
  decision: string;
  artifact?: string | null;
  evidenceRefs?: string[];
}): SoloThread {
  const context = [
    "COUNCIL CONTEXT FOR DISCUSSION",
    "This is a follow-up conversation. Do not rerun the Council.",
    input.decision,
    input.artifact ? `ARTIFACT\n${input.artifact}` : "",
    input.evidenceRefs?.length ? `EVIDENCE REFS\n${input.evidenceRefs.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const thread = createSoloThread({
    id: input.id,
    projectId: input.projectId,
    provider: input.provider,
    modelId: input.modelId,
    modelLabel: input.modelLabel,
    title: "Council follow-up",
    now: input.now,
    contextText: context,
  });
  return { ...thread, contextEnabled: false };
}

export function renderSoloMarkdown(thread: SoloThread, manifest: string[]): string {
  const lines = [
    `# SOLO`,
    ``,
    `- provider: ${thread.provider}`,
    `- model: ${thread.modelLabel} (${thread.modelId})`,
    `- thread: ${thread.id}`,
    ``,
    `## Sources`,
    ...(manifest.length ? manifest.map((row) => `- ${row}`) : ["- none"]),
    ``,
  ];
  for (const row of thread.messages) {
    if (row.role === "TRANSITION") continue;
    lines.push(`## ${row.role} · ${row.createdAt}`, ``, row.content || "—", ``);
    if (row.citations.length) lines.push(`Citations: ${row.citations.join(", ")}`, ``);
    if (row.stopped) lines.push(`Stopped`, ``);
  }
  if (thread.transitions.length) {
    lines.push(`## Model transitions`, ``);
    for (const row of thread.transitions) {
      lines.push(`- ${row.at}: ${row.fromProvider}/${row.fromModelId} -> ${row.toProvider}/${row.toModelId}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

export function renderSoloJson(thread: SoloThread): string {
  return JSON.stringify(
    {
      language: "en",
      threadId: thread.id,
      provider: thread.provider,
      modelId: thread.modelId,
      messages: thread.messages,
      transitions: thread.transitions,
    },
    null,
    2,
  );
}

export function parseSseDeltas(buffer: string): { rest: string; deltas: string[]; done: boolean } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const json = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) deltas.push(delta);
    } catch {
      /* ignore partial */
    }
  }
  return { rest, deltas, done };
}

export function revealChunks(text: string, parts = 4): string[] {
  if (!text) return [];
  const size = Math.max(1, Math.ceil(text.length / parts));
  const out: string[] = [];
  for (let i = size; i < text.length; i += size) out.push(text.slice(0, i));
  out.push(text);
  return out;
}

export type SoloCompletion = {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  latencyMs: number | null;
};

export async function executeSoloTurn(input: {
  thread: SoloThread;
  userText?: string;
  regenerate?: boolean;
  context: SoloContextInput;
  now: string;
  cancelled: () => boolean;
  preflight: (provider: ProviderId, modelId: string) => Promise<{ ok: boolean; error?: string }>;
  complete: (request: { provider: ProviderId; modelId: string; messages: Array<{ role: string; content: string }> }) => Promise<SoloCompletion>;
  retryable?: (error: unknown) => boolean;
}): Promise<{ thread: SoloThread; calls: number; usageKind: typeof SOLO_CALLS; dispatchedModel: string; error: string | null }> {
  let thread = input.regenerate ? dropLastAssistant(input.thread) : input.thread;
  if (!input.regenerate) thread = withUserMessage(thread, input.userText ?? "", input.now);
  const user = [...thread.messages].reverse().find((row) => row.role === "USER");
  if (!user) {
    return { thread: input.thread, calls: 0, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: "EMPTY_MESSAGE" };
  }
  const gate = await input.preflight(thread.provider, thread.modelId);
  if (!gate.ok) {
    return { thread, calls: 0, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: gate.error ?? "PREFLIGHT_FAILED" };
  }
  const pack = buildContextPack(thread, input.context);
  const messages = modelMessages(thread, pack.text);
  let calls = 0;
  let lastError = "";
  let completion: SoloCompletion | null = null;
  const retryable = input.retryable ?? (() => false);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (input.cancelled()) {
      return { thread, calls, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: "STOPPED" };
    }
    calls += 1;
    try {
      completion = await input.complete({ provider: thread.provider, modelId: thread.modelId, messages });
      lastError = "";
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "PROVIDER_ERROR";
      if (attempt === 3 || !retryable(error)) break;
    }
  }
  if (input.cancelled()) {
    const stopped = withAssistantMessage(thread, { content: "", now: input.now, stopped: true, error: "STOPPED", states: pack.states });
    return { thread: stopped, calls, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: "STOPPED" };
  }
  if (!completion) {
    const failed = withAssistantMessage(thread, { content: "", now: input.now, error: lastError || "PROVIDER_ERROR", states: pack.states });
    return { thread: failed, calls, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: lastError || "PROVIDER_ERROR" };
  }
  const next = withAssistantMessage(thread, {
    content: completion.text,
    now: input.now,
    states: pack.states,
    usage: completion,
  });
  return { thread: next, calls, usageKind: SOLO_CALLS, dispatchedModel: thread.modelId, error: null };
}
