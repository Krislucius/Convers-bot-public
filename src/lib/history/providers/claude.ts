import type { ParsedTurn } from "../types.ts";
import { mapRole, speakerFromRole } from "./roles.ts";

type ClaudeMessage = {
  sender?: string;
  role?: string;
  text?: string;
  content?: unknown;
  created_at?: string;
};

export function parseClaudeJson(raw: string): { title: string | null; turns: ParsedTurn[] } | null {
  try {
    const parsed = JSON.parse(raw) as {
      name?: string;
      title?: string;
      chat_messages?: ClaudeMessage[];
      messages?: ClaudeMessage[];
    };
    const rows = parsed.chat_messages ?? parsed.messages;
    if (!Array.isArray(rows) || rows.length < 1) return null;
    const turns: ParsedTurn[] = [];
    for (const row of rows) {
      const rawRole = String(row.sender ?? row.role ?? "unknown");
      const content =
        typeof row.text === "string"
          ? row.text
          : typeof row.content === "string"
            ? row.content
            : "";
      if (!content.trim()) continue;
      const role = mapRole(rawRole === "human" ? "user" : rawRole);
      turns.push({
        role,
        speaker: speakerFromRole(role, rawRole),
        content: content.trim(),
        timestamp: typeof row.created_at === "string" ? row.created_at : null,
      });
    }
    if (!turns.length) return null;
    return { title: parsed.name ?? parsed.title ?? null, turns };
  } catch {
    return null;
  }
}

export function parseClaudeHtml(html: string): { title: string | null; turns: ParsedTurn[] } | null {
  const json = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (json?.[1]) {
    const parsed = parseClaudeJson(json[1]);
    if (parsed) return parsed;
  }
  return null;
}

export function claudeHasSharePayload(body: string): boolean {
  return Boolean(parseClaudeJson(body) || parseClaudeHtml(body));
}
