import type { ChatSource, HistoryMessage } from "./types.ts";

export const PRIVACY_NOTE =
  "This app never asks for ChatGPT, Grok, or Claude passwords, and it never reads or stores browser cookies or session tokens.";

export const HISTORY_NOT_CANONICAL =
  "Imported chats are historical evidence. They do not become frozen invariants, active decisions, or current project state.";

export type HistoryContextItem = {
  id: string;
  projectId: string;
  source: "IMPORT";
  kind: "RAW_HISTORY";
  status: "RAW";
  content: string;
  createdAt: string;
};

export function sourcesForProject(sources: ChatSource[], projectId: string): ChatSource[] {
  return sources.filter((source) => source.projectId === projectId);
}

export function messagesForSource(messages: HistoryMessage[], chatSourceId: string): HistoryMessage[] {
  return messages.filter((row) => row.chatSourceId === chatSourceId).sort((a, b) => a.sequence - b.sequence);
}

export function filterSelectedForProject(
  selectedIds: string[],
  sources: ChatSource[],
  projectId: string,
): string[] {
  const allowed = new Set(sourcesForProject(sources, projectId).map((source) => source.id));
  return selectedIds.filter((id) => allowed.has(id));
}

export function findDuplicate(
  sources: ChatSource[],
  projectId: string,
  contentHash: string,
): ChatSource | undefined {
  return sources.find(
    (source) =>
      source.projectId === projectId &&
      source.contentHash === contentHash &&
      source.importStatus !== "ARCHIVED",
  );
}

export function applyRemoteAccessChange<T extends Pick<ChatSource, "rawContent" | "contentHash" | "importedAt">>(
  source: T,
  patch: Pick<ChatSource, "accessStatus" | "lastAccessCheckAt" | "lastError">,
): T {
  return {
    ...source,
    ...patch,
    rawContent: source.rawContent,
    contentHash: source.contentHash,
    importedAt: source.importedAt,
  };
}

export function memoryChatIds(sources: ChatSource[], projectId: string): string[] {
  return sources
    .filter((source) => source.projectId === projectId && source.includeInMemory && source.importStatus !== "ARCHIVED")
    .map((source) => source.id);
}

export function memoryChatCount(sources: ChatSource[], projectId: string): { included: number; total: number } {
  const rows = sources.filter((source) => source.projectId === projectId);
  return {
    total: rows.length,
    included: rows.filter((source) => source.includeInMemory && source.importStatus !== "ARCHIVED").length,
  };
}

export function resolveChatsForRun(
  projectId: string,
  selectedIds: string[],
  sources: ChatSource[],
): ChatSource[] {
  const pool = sources.filter((source) => source.projectId === projectId && source.importStatus !== "ARCHIVED");
  return pool.filter((source) => selectedIds.includes(source.id));
}

export function selectedChatsToContext(
  projectId: string,
  selectedIds: string[],
  sources: ChatSource[],
  messages: HistoryMessage[],
): HistoryContextItem[] {
  const chosen = resolveChatsForRun(projectId, selectedIds, sources);
  const now = new Date().toISOString();
  return chosen.map((source) => {
    const turns = messagesForSource(messages, source.id);
    const body = turns.length
      ? turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n\n")
      : source.rawContent;
    const item: HistoryContextItem = {
      id: `hist-${source.id}`,
      projectId,
      source: "IMPORT",
      kind: "RAW_HISTORY",
      status: "RAW",
      content: `UNTRUSTED historical chat "${source.title}" (${source.provider}):\n${body}`,
      createdAt: source.importedAt ?? now,
    };
    return item;
  });
}

export function assertHistoryIsNotCanonical(items: HistoryContextItem[]): boolean {
  return items.every((item) => item.kind === "RAW_HISTORY" && item.status === "RAW" && item.source === "IMPORT");
}

export const FORBIDDEN_SOURCE_KEYS = ["cookie", "cookies", "password", "passwords", "sessionToken", "session_token"] as const;

export function sourceHasSecretFields(source: object): boolean {
  const keys = Object.keys(source);
  return FORBIDDEN_SOURCE_KEYS.some((key) => keys.includes(key));
}
