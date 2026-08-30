import { parseGrokJson } from "./grok.ts";
import { parseSpeakerTurns } from "./generic.ts";
import type { ParsedTurn } from "../types.ts";

export function parseGrokBuild(raw: string): { title: string | null; turns: ParsedTurn[] } | null {
  const json = parseGrokJson(raw);
  if (json) return json;
  const turns = parseSpeakerTurns(raw);
  if (!turns) return null;
  return { title: null, turns };
}
