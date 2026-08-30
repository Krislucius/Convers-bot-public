import type { ParsedTurn } from "../types.ts";
import { mapRole, speakerFromRole } from "./roles.ts";

export function parseGrokJson(raw: string): { title: string | null; turns: ParsedTurn[] } | null {
  try {
    const parsed = JSON.parse(raw) as {
      title?: string;
      conversation?: { title?: string; messages?: Array<{ role?: string; sender?: string; content?: string }> };
      messages?: Array<{ role?: string; sender?: string; content?: string }>;
    };
    const rows = parsed.messages ?? parsed.conversation?.messages;
    if (!Array.isArray(rows) || rows.length < 1) return null;
    const turns: ParsedTurn[] = [];
    for (const row of rows) {
      const rawRole = String(row.role ?? row.sender ?? "unknown");
      const content = typeof row.content === "string" ? row.content.trim() : "";
      if (!content) continue;
      const role = mapRole(rawRole);
      turns.push({ role, speaker: speakerFromRole(role, rawRole), content, timestamp: null });
    }
    if (!turns.length) return null;
    return { title: parsed.title ?? parsed.conversation?.title ?? null, turns };
  } catch {
    return null;
  }
}

export function grokHasSharePayload(body: string): boolean {
  return Boolean(parseGrokJson(body));
}
