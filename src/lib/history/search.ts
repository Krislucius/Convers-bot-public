import type { ChatProvider, ChatSource, HistoryMessage } from "./types.ts";

export type ChatSearchQuery = {
  q: string;
  provider: ChatProvider | "ALL";
  title: string;
  includeArchived?: boolean;
};

export function searchChatSources(
  sources: ChatSource[],
  messages: HistoryMessage[],
  projectId: string,
  query: ChatSearchQuery,
): ChatSource[] {
  const needle = query.q.trim().toLowerCase();
  const titleNeedle = query.title.trim().toLowerCase();
  return sources.filter((source) => {
    if (source.projectId !== projectId) return false;
    if (!query.includeArchived && source.importStatus === "ARCHIVED") return false;
    if (query.provider !== "ALL" && source.provider !== query.provider) return false;
    if (titleNeedle && !source.title.toLowerCase().includes(titleNeedle)) return false;
    if (!needle) return true;
    if (source.title.toLowerCase().includes(needle)) return true;
    if (source.rawContent.toLowerCase().includes(needle)) return true;
    return messages.some(
      (row) => row.chatSourceId === source.id && row.content.toLowerCase().includes(needle),
    );
  });
}
