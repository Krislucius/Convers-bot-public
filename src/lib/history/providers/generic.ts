import type { ParsedTurn } from "../types.ts";
import { mapRole, speakerFromRole } from "./roles.ts";

const SPEAKER_LINE =
  /^(?:#{1,6}\s*)?(?:\*\*|__)?(user|human|you|operator|assistant|chatgpt|gpt|grok|claude|system|tool|model|ai)(?:\*\*|__)?\s*[:\-–]\s*(.*)$/i;

export function parseSpeakerTurns(raw: string): ParsedTurn[] | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;
  for (const line of lines) {
    const match = SPEAKER_LINE.exec(line.trim());
    if (match) {
      if (current && current.content.trim()) turns.push({ ...current, content: current.content.trim() });
      const role = mapRole(match[1]);
      current = {
        role,
        speaker: speakerFromRole(role, match[1]),
        content: match[2] ?? "",
        timestamp: null,
      };
      continue;
    }
    if (current) current.content += `${current.content ? "\n" : ""}${line}`;
  }
  if (current && current.content.trim()) turns.push({ ...current, content: current.content.trim() });
  const roles = new Set(turns.map((t) => t.role));
  if (turns.length < 2 || roles.size < 2) return null;
  return turns;
}

export function parseJsonl(raw: string): ParsedTurn[] | null {
  const turns: ParsedTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { role?: string; speaker?: string; content?: string; text?: string };
      const content = String(row.content ?? row.text ?? "").trim();
      if (!content) continue;
      const role = mapRole(String(row.role ?? row.speaker ?? "unknown"));
      turns.push({
        role,
        speaker: speakerFromRole(role, row.speaker ?? row.role),
        content,
        timestamp: null,
      });
    } catch {
      return null;
    }
  }
  return turns.length >= 2 ? turns : null;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
