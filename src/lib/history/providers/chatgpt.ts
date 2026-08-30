import type { ParsedTurn } from "../types.ts";
import { mapRole, partsToText, speakerFromRole } from "./roles.ts";

type MappingNode = {
  message?: {
    author?: { role?: string };
    content?: unknown;
    create_time?: number;
    metadata?: { is_visually_hidden_from_conversation?: boolean };
  } | null;
  parent?: string | null;
  children?: string[];
};

export type ChatGptParse = {
  title: string | null;
  turns: ParsedTurn[];
  canonicalRaw?: string;
};

const GENERIC_TITLE = /^(посмотрите этот чат|view this chat|shared conversation|chatgpt)$/i;

export function findMapping(value: unknown, depth = 0): Record<string, MappingNode> | null {
  if (!value || depth > 14 || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (rec.mapping && typeof rec.mapping === "object" && rec.mapping) {
    return rec.mapping as Record<string, MappingNode>;
  }
  for (const nested of Object.values(rec)) {
    if (nested && typeof nested === "object") {
      const found = findMapping(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function findTitle(value: unknown, depth = 0): string | null {
  if (!value || depth > 14 || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.title === "string" && rec.title.trim() && !GENERIC_TITLE.test(rec.title.trim())) {
    return rec.title.trim();
  }
  if (typeof rec.pageTitle === "string" && rec.pageTitle.trim() && !GENERIC_TITLE.test(rec.pageTitle.trim())) {
    return rec.pageTitle.trim();
  }
  for (const nested of Object.values(rec)) {
    if (nested && typeof nested === "object") {
      const found = findTitle(nested, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseMapping(mapping: Record<string, MappingNode>): ParsedTurn[] {
  const turns: Array<ParsedTurn & { time: number }> = [];
  for (const node of Object.values(mapping)) {
    const message = node?.message;
    if (!message) continue;
    if (message.metadata?.is_visually_hidden_from_conversation) continue;
    const rawRole = String(message.author?.role ?? "unknown");
    const content = partsToText(message.content).trim();
    if (!content) continue;
    const role = mapRole(rawRole);
    if (role === "SYSTEM" && content.length < 8) continue;
    if (role === "TOOL") continue;
    turns.push({
      role,
      speaker: speakerFromRole(role, rawRole),
      content,
      timestamp: typeof message.create_time === "number" ? new Date(message.create_time * 1000).toISOString() : null,
      time: typeof message.create_time === "number" ? message.create_time : 0,
    });
  }
  turns.sort((a, b) => a.time - b.time);
  return turns.map(({ time: _t, ...turn }) => turn);
}

function toCanonical(title: string | null, mapping: Record<string, MappingNode>): string {
  const turns = parseMapping(mapping);
  return JSON.stringify({
    title: title ?? "ChatGPT share",
    messages: turns.map((turn) => ({
      role: turn.role === "USER" ? "user" : turn.role === "ASSISTANT" ? "assistant" : turn.role.toLowerCase(),
      content: turn.content,
      timestamp: turn.timestamp,
    })),
  });
}

function fromMapping(title: string | null, mapping: Record<string, MappingNode>): ChatGptParse | null {
  const turns = parseMapping(mapping);
  if (!turns.length) return null;
  return { title: title ?? findTitle({ mapping, title }), turns, canonicalRaw: toCanonical(title, mapping) };
}

export function parseChatGptJson(raw: string): ChatGptParse | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const first = items[0];
    if (first && typeof first === "object") {
      const rec = first as { title?: unknown; messages?: unknown };
      if (Array.isArray(rec.messages) && rec.messages.length >= 2 && !("mapping" in rec)) {
        const turns: ParsedTurn[] = [];
        for (const row of rec.messages) {
          if (!row || typeof row !== "object") continue;
          const item = row as { role?: unknown; content?: unknown; timestamp?: unknown };
          const content = partsToText(item.content).trim();
          if (!content) continue;
          const role = mapRole(String(item.role ?? "unknown"));
          if (role === "TOOL" || (role === "SYSTEM" && content.length < 8)) continue;
          turns.push({
            role,
            speaker: speakerFromRole(role, String(item.role ?? "")),
            content,
            timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
          });
        }
        if (turns.length >= 2) {
          const title = typeof rec.title === "string" ? rec.title : null;
          return { title, turns, canonicalRaw: raw.trim() };
        }
      }
    }
    const mapping = findMapping(first);
    if (!mapping) return null;
    const turns = parseMapping(mapping);
    if (!turns.length) return null;
    const title = findTitle(first);
    return { title, turns, canonicalRaw: toCanonical(title, mapping) };
  } catch {
    return null;
  }
}

export function extractJsonScripts(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const body = match[1]?.trim() ?? "";
    if (!body || body.length > 400_000) continue;
    const blobs = [body];
    const eq = body.indexOf("=");
    if (eq > 0 && /window\.|self\.|globalThis\./.test(body.slice(0, eq))) {
      blobs.push(body.slice(eq + 1).replace(/;+\s*$/, ""));
    }
    for (const blob of blobs) {
      try {
        out.push(JSON.parse(blob));
      } catch {
        /* not JSON */
      }
    }
  }
  return out;
}

function scanJsonString(source: string, start: number): { raw: string; end: number } | null {
  if (source[start] !== '"') return null;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') return { raw: source.slice(start, i + 1), end: i + 1 };
    i += 1;
  }
  return null;
}

function extractFlightTables(html: string): unknown[][] {
  const tables: unknown[][] = [];
  const needle = "streamController.enqueue(";
  let from = 0;
  while (from < html.length) {
    const start = html.indexOf(needle, from);
    if (start < 0) break;
    let i = start + needle.length;
    while (i < html.length && (html[i] === " " || html[i] === "\n")) i += 1;
    if (html[i] !== '"') {
      from = start + needle.length;
      continue;
    }
    const scanned = scanJsonString(html, i);
    if (!scanned) {
      from = start + needle.length;
      continue;
    }
    try {
      const asString = JSON.parse(scanned.raw) as unknown;
      const parsed = typeof asString === "string" ? (JSON.parse(asString) as unknown) : asString;
      if (Array.isArray(parsed) && parsed.length > 8) tables.push(parsed);
    } catch {
      /* ignore malformed flight chunk */
    }
    from = scanned.end;
  }
  return tables;
}

function isRefObject(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => /^_\d+$/.test(key));
}

function hydrateFlight(table: unknown[]): unknown {
  const cache = new Map<number, unknown>();
  function deref(index: number): unknown {
    if (!Number.isInteger(index)) return index;
    if (index < 0) return null;
    if (cache.has(index)) return cache.get(index);
    if (index >= table.length) return index;
    const raw = table[index];
    if (raw === null || typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") {
      cache.set(index, raw);
      return raw;
    }
    if (Array.isArray(raw)) {
      const arr: unknown[] = [];
      cache.set(index, arr);
      for (const item of raw) {
        arr.push(typeof item === "number" ? deref(item) : item);
      }
      return arr;
    }
    if (isRefObject(raw)) {
      const obj: Record<string, unknown> = {};
      cache.set(index, obj);
      for (const [key, val] of Object.entries(raw)) {
        const resolvedKey = deref(Number(key.slice(1)));
        obj[String(resolvedKey)] = typeof val === "number" ? deref(val) : val;
      }
      return obj;
    }
    cache.set(index, raw);
    return raw;
  }
  return deref(0);
}

function lookupKey(table: unknown[], key: string): unknown {
  const keyIndex = table.indexOf(key);
  if (keyIndex < 0) return undefined;
  for (const item of table) {
    if (!isRefObject(item)) continue;
    const slot = item[`_${keyIndex}`];
    if (typeof slot === "number") {
      return hydrateFlightAt(table, slot);
    }
  }
  if (keyIndex + 1 < table.length) return hydrateFlightAt(table, keyIndex + 1);
  return undefined;
}

function hydrateFlightAt(table: unknown[], index: number): unknown {
  const cache = new Map<number, unknown>();
  function deref(slot: number): unknown {
    if (!Number.isInteger(slot) || slot < 0) return null;
    if (cache.has(slot)) return cache.get(slot);
    if (slot >= table.length) return slot;
    const raw = table[slot];
    if (raw === null || typeof raw === "string" || typeof raw === "boolean" || typeof raw === "number") {
      cache.set(slot, raw);
      return raw;
    }
    if (Array.isArray(raw)) {
      const arr: unknown[] = [];
      cache.set(slot, arr);
      for (const item of raw) arr.push(typeof item === "number" ? deref(item) : item);
      return arr;
    }
    if (isRefObject(raw)) {
      const obj: Record<string, unknown> = {};
      cache.set(slot, obj);
      for (const [key, val] of Object.entries(raw)) {
        obj[String(deref(Number(key.slice(1))))] = typeof val === "number" ? deref(val) : val;
      }
      return obj;
    }
    cache.set(slot, raw);
    return raw;
  }
  return deref(index);
}

function mappingFromLinear(nodes: unknown[]): Record<string, MappingNode> | null {
  const mapping: Record<string, MappingNode> = {};
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const rec = node as { id?: unknown; message?: MappingNode["message"]; parent?: unknown; children?: unknown };
    const id = typeof rec.id === "string" ? rec.id : null;
    if (!id) continue;
    mapping[id] = {
      message: rec.message ?? null,
      parent: typeof rec.parent === "string" ? rec.parent : null,
      children: Array.isArray(rec.children) ? rec.children.filter((child): child is string => typeof child === "string") : [],
    };
  }
  return Object.keys(mapping).length ? mapping : null;
}

export function parseChatGptFlight(html: string): ChatGptParse | null {
  const tables = extractFlightTables(html);
  for (const table of tables) {
    const hydrated = hydrateFlight(table);
    const mapping = findMapping(hydrated) ?? mappingFromLinear(Array.isArray(lookupKey(table, "linear_conversation")) ? (lookupKey(table, "linear_conversation") as unknown[]) : []);
    const title =
      (typeof lookupKey(table, "pageTitle") === "string" ? (lookupKey(table, "pageTitle") as string) : null) ??
      (typeof lookupKey(table, "title") === "string" ? (lookupKey(table, "title") as string) : null) ??
      findTitle(hydrated);
    if (mapping) {
      const parsed = fromMapping(title && !GENERIC_TITLE.test(title) ? title : findTitle(hydrated), mapping);
      if (parsed && parsed.turns.length >= 2) return parsed;
    }
  }
  return null;
}

export function parseChatGptHtml(html: string): ChatGptParse | null {
  const scripts = extractJsonScripts(html);
  for (const script of scripts) {
    const mapping = findMapping(script);
    if (!mapping) continue;
    const turns = parseMapping(mapping);
    if (turns.length) {
      const title = findTitle(script) ?? titleFromHtml(html);
      return { title, turns, canonicalRaw: toCanonical(title, mapping) };
    }
  }
  const flight = parseChatGptFlight(html);
  if (flight?.turns.length) {
    return { ...flight, title: flight.title ?? titleFromHtml(html) };
  }
  const roles = [...html.matchAll(/data-message-author-role="([^"]+)"/gi)];
  if (roles.length >= 2) {
    const chunks = html.split(/data-message-author-role="/i).slice(1);
    const turns: ParsedTurn[] = [];
    for (const chunk of chunks) {
      const roleEnd = chunk.indexOf('"');
      const rawRole = chunk.slice(0, roleEnd);
      const text = chunk
        .replace(/<[^>]+>/g, "\n")
        .replace(/&/g, "&")
        .replace(/</g, "<")
        .replace(/>/g, ">")
        .replace(/"/g, '"')
        .replace(/\n{2,}/g, "\n")
        .trim();
      if (!text) continue;
      const role = mapRole(rawRole);
      turns.push({ role, speaker: speakerFromRole(role, rawRole), content: text, timestamp: null });
    }
    if (turns.length >= 2) return { title: titleFromHtml(html), turns };
  }
  return null;
}

export function titleFromHtml(html: string): string | null {
  const title = /<title>([^<]+)<\/title>/i.exec(html);
  if (title?.[1]) {
    const cleaned = title[1]
      .replace(/\s*[—|-]\s*ChatGPT.*$/i, "")
      .replace(/^ChatGPT\s*[—|-]\s*/i, "")
      .trim();
    if (cleaned && !GENERIC_TITLE.test(cleaned)) return cleaned;
  }
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) {
    const value = og[1].trim();
    if (value && !GENERIC_TITLE.test(value)) return value;
  }
  return title?.[1]?.trim() || null;
}

export function chatgptHasSharePayload(body: string): boolean {
  return Boolean(parseChatGptJson(body) || parseChatGptHtml(body));
}
