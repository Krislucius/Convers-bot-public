import { detectProviderFromUrl } from "./detect.ts";
import { estimateTokens, hashContent } from "./hash.ts";
import { detectProviderFromStructuredContent, parseConversation } from "./parse.ts";
import type { AccessStatus, ChatProvider, ChatSource, HistoryMessage, ImportMethod, ImportStatus, ParsedTurn } from "./types.ts";

function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

export function turnsToMessages(chatSourceId: string, turns: ParsedTurn[]): HistoryMessage[] {
  return turns.map((turn, index) => ({
    id: nid(),
    chatSourceId,
    sequence: index,
    speaker: turn.speaker,
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
  }));
}

export function resolveImportProvider(
  chosen: ChatProvider | "AUTO",
  raw: string,
  url?: string | null,
): ChatProvider {
  if (chosen !== "AUTO") return chosen;
  const structured = detectProviderFromStructuredContent(raw);
  if (structured) return structured;
  if (url) return detectProviderFromUrl(url);
  return "UNKNOWN";
}

export function buildChatSource(input: {
  projectId: string;
  provider: ChatProvider;
  title: string;
  sourceUrl: string | null;
  importMethod: ImportMethod;
  accessStatus: AccessStatus;
  importStatus: ImportStatus;
  rawContent: string;
  lastError?: string | null;
  createdAt?: string;
  includeInMemory?: boolean;
}): { source: ChatSource; messages: HistoryMessage[] } {
  const id = nid();
  const now = input.createdAt ?? new Date().toISOString();
  const parsed = parseConversation(input.provider, input.rawContent);
  const messages = turnsToMessages(id, parsed.turns);
  const characterCount = input.rawContent.length;
  const source: ChatSource = {
    id,
    projectId: input.projectId,
    provider: input.provider,
    title: input.title.trim() || parsed.title || `${input.provider} ${input.importMethod.toLowerCase()}`,
    sourceUrl: input.sourceUrl,
    importMethod: input.importMethod,
    accessStatus: input.accessStatus,
    importStatus: input.importStatus,
    rawContent: input.rawContent,
    messageCount: messages.length ? messages.length : null,
    characterCount,
    estimatedTokenCount: characterCount ? estimateTokens(characterCount) : null,
    contentHash: hashContent(input.rawContent),
    createdAt: now,
    importedAt: input.importStatus === "IMPORTED" ? now : null,
    lastAccessCheckAt: input.importMethod === "URL" ? now : null,
    lastError: input.lastError ?? null,
    includeInMemory: input.includeInMemory === true && input.importStatus !== "ARCHIVED",
  };
  return { source, messages };
}
