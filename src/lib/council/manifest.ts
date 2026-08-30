import { hashContent } from "../history/hash.ts";
import { messagesForSource, resolveChatsForRun } from "../history/provenance.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import { nid } from "./protocol.ts";
import type {
  Artifact,
  ChatManifestRow,
  ContextItem,
  ContextManifest,
  ContextManifestPayload,
  FileManifestRow,
  Project,
  ProjectFile,
  Task,
} from "./types.ts";

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortValue(record[key])]),
    );
  }
  return value;
}

export function hashCanonical(value: unknown): string {
  return hashContent(stableStringify(value));
}

export function chatManifestRows(
  projectId: string,
  selectedIds: string[],
  sources: ChatSource[],
  messages: HistoryMessage[],
): ChatManifestRow[] {
  return resolveChatsForRun(projectId, selectedIds, sources).map((source) => {
    const turns = messagesForSource(messages, source.id);
    const local = turns.length > 0 || source.rawContent.trim().length > 0;
    return {
      source_id: source.id,
      title: source.title,
      provider: source.provider,
      import_status: source.importStatus,
      access_status: source.accessStatus,
      message_count: source.messageCount ?? (turns.length || null),
      character_count: source.characterCount,
      estimated_tokens: source.estimatedTokenCount,
      content_available_locally: local,
    };
  });
}

export function fileManifestRows(projectId: string, selectedIds: string[], files: ProjectFile[]): FileManifestRow[] {
  return files
    .filter((file) => file.projectId === projectId && selectedIds.includes(file.id))
    .map((file) => ({
      file_id: file.id,
      filename: file.filename,
      kind: file.kind,
      character_count: file.characterCount,
      estimated_tokens: file.estimatedTokens,
      member_count: file.members.length,
      include_in_memory: file.includeInMemory,
    }));
}

export function buildManifestPayload(input: {
  project: Project;
  task: Task;
  context: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  artifacts: Artifact[];
  projectFiles?: ProjectFile[];
}): ContextManifestPayload {
  const items = input.context.filter((row) => row.projectId === input.project.id && row.kind !== "RAW_HISTORY");
  const candidate = input.task.candidateArtifactId
    ? input.artifacts.find((row) => row.id === input.task.candidateArtifactId) ?? null
    : null;
  return {
    project: { id: input.project.id, name: input.project.name, description: input.project.description },
    task: {
      id: input.task.id,
      title: input.task.title,
      prompt: input.task.prompt,
      mode: input.task.mode,
      requiresHistoricalContext: input.task.requiresHistoricalContext,
      candidateArtifactId: input.task.candidateArtifactId,
      decisionQuestion: input.task.decisionQuestion,
    },
    selectedAiChats: chatManifestRows(
      input.project.id,
      input.task.selectedChatSourceIds,
      input.chatSources,
      input.historyMessages,
    ),
    selectedFiles: fileManifestRows(input.project.id, input.task.selectedFileIds ?? [], input.projectFiles ?? []),
    frozenInvariants: items
      .filter((row) => row.kind === "INVARIANT")
      .map((row) => ({ id: row.id, content: row.content })),
    activeDecisions: items
      .filter((row) => row.kind === "DECISION")
      .map((row) => ({ id: row.id, content: row.content })),
    activeSpecifications: items
      .filter((row) => row.kind === "SPECIFICATION")
      .map((row) => ({ id: row.id, content: row.content })),
    projectState: items
      .filter((row) => row.kind === "PROJECT_STATE")
      .map((row) => ({ id: row.id, content: row.content })),
    candidateArtifact: candidate
      ? { id: candidate.id, title: candidate.title, version: candidate.version, status: candidate.status }
      : null,
  };
}

export function persistableManifest(input: {
  project: Project;
  task: Task;
  context: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  artifacts: Artifact[];
  projectFiles?: ProjectFile[];
  contextText: string;
}): ContextManifest {
  const payload = buildManifestPayload(input);
  const hash = hashCanonical({ payload, contextText: input.contextText });
  return {
    id: nid(),
    taskId: input.task.id,
    hash,
    payload,
    createdAt: new Date().toISOString(),
  };
}

export function manifestCounts(payload: ContextManifestPayload) {
  const chats = payload.selectedAiChats;
  const messages = chats.reduce((sum, row) => sum + (row.message_count ?? 0), 0);
  const chars = chats.reduce((sum, row) => sum + row.character_count, 0);
  const tokens = chats.reduce((sum, row) => sum + (row.estimated_tokens ?? Math.ceil(row.character_count / 4)), 0);
  return {
    chats: chats.length,
    messages,
    chars,
    tokens,
    frozenInvariants: payload.frozenInvariants.length,
    activeDecisions: payload.activeDecisions.length,
    specifications: payload.activeSpecifications.length,
    projectState: payload.projectState.length,
  };
}
