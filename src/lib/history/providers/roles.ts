import type { HistoryRole } from "../types.ts";

export function mapRole(raw: string): HistoryRole {
  const value = raw.trim().toLowerCase();
  if (value === "user" || value === "human" || value === "you" || value === "operator") return "USER";
  if (
    value === "assistant" ||
    value === "chatgpt" ||
    value === "gpt" ||
    value === "grok" ||
    value === "claude" ||
    value === "bot" ||
    value === "model" ||
    value === "ai"
  ) {
    return "ASSISTANT";
  }
  if (value === "system") return "SYSTEM";
  if (value === "tool" || value === "function" || value === "tool_result") return "TOOL";
  return "UNKNOWN";
}

export function speakerFromRole(role: HistoryRole, raw?: string): string {
  if (raw && raw.trim()) return raw.trim();
  if (role === "USER") return "User";
  if (role === "ASSISTANT") return "Assistant";
  if (role === "SYSTEM") return "System";
  if (role === "TOOL") return "Tool";
  return "Unknown";
}

export function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const rec = content as { parts?: unknown; text?: unknown; content?: unknown };
  if (typeof rec.text === "string") return rec.text;
  if (Array.isArray(rec.parts)) {
    return rec.parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof rec.content === "string") return rec.content;
  return "";
}
