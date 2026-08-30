import { parseChatGptHtml, parseChatGptJson } from "./providers/chatgpt.ts";
import { parseClaudeHtml, parseClaudeJson } from "./providers/claude.ts";
import { parseGrokJson } from "./providers/grok.ts";
import { parseGrokBuild } from "./providers/grok-build.ts";
import { parseJsonl, parseSpeakerTurns, stripHtml } from "./providers/generic.ts";
import type { ChatProvider, ParsedTurn } from "./types.ts";

export type ParseResult = {
  title: string | null;
  turns: ParsedTurn[];
  reliable: boolean;
  canonicalRaw?: string;
};

function fromTurns(title: string | null, turns: ParsedTurn[] | null, canonicalRaw?: string): ParseResult | null {
  if (!turns || !turns.length) return null;
  return { title, turns, reliable: turns.length >= 2, canonicalRaw };
}

export function parseConversation(
  provider: ChatProvider,
  raw: string,
  filename?: string,
): ParseResult {
  const lower = (filename ?? "").toLowerCase();
  const trimmed = raw.trim();
  if (!trimmed) return { title: null, turns: [], reliable: false };

  const chatgpt = parseChatGptJson(trimmed) ?? (trimmed.includes("<") || trimmed.includes("streamController") ? parseChatGptHtml(trimmed) : null);
  if (chatgpt?.turns.length) {
    return {
      title: chatgpt.title,
      turns: chatgpt.turns,
      reliable: true,
      canonicalRaw: chatgpt.canonicalRaw,
    };
  }
  const claude = parseClaudeJson(trimmed) ?? (trimmed.includes("<") ? parseClaudeHtml(trimmed) : null);
  if (claude?.turns.length) {
    return { title: claude.title, turns: claude.turns, reliable: true };
  }
  const grok = provider === "GROK_BUILD" ? parseGrokBuild(trimmed) : parseGrokJson(trimmed);
  if (grok?.turns.length) {
    return { title: grok.title, turns: grok.turns, reliable: true };
  }
  if (lower.endsWith(".jsonl") || (trimmed.includes("\n") && trimmed.startsWith("{"))) {
    const jsonl = parseJsonl(trimmed);
    const parsed = fromTurns(null, jsonl);
    if (parsed) return parsed;
  }
  const text = lower.endsWith(".html") || /<\/?[a-z][\s\S]*>/i.test(trimmed) ? stripHtml(trimmed) : trimmed;
  const speakers = fromTurns(null, parseSpeakerTurns(text));
  if (speakers) return speakers;
  return { title: null, turns: [], reliable: false };
}

export function detectProviderFromStructuredContent(raw: string): ChatProvider | null {
  if (parseChatGptJson(raw.trim()) || (raw.includes("mapping") && parseChatGptHtml(raw))) return "CHATGPT";
  if (parseClaudeJson(raw.trim())) return "CLAUDE";
  if (parseGrokJson(raw.trim())) return "GROK";
  return null;
}

export function hasReliablePayload(provider: ChatProvider, raw: string): boolean {
  return parseConversation(provider, raw).reliable;
}
