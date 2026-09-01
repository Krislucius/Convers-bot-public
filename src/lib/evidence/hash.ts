import { hashContent } from "../history/hash.ts";
import {
  CHUNKER_VERSION,
  EXTRACTOR_MODEL,
  EXTRACTOR_PROMPT_VERSION,
  EXTRACTOR_VERSION,
} from "./types.ts";

export function extractorFingerprint(): string {
  return `${EXTRACTOR_VERSION}:${EXTRACTOR_MODEL}:${EXTRACTOR_PROMPT_VERSION}`;
}

export function cacheFingerprint(sourceHash: string): string {
  return hashContent(`${sourceHash}|${CHUNKER_VERSION}|${extractorFingerprint()}`);
}

export { hashContent };
