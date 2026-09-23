import { hashContent } from "../history/hash.ts";
import type { ProjectFile } from "../council/types.ts";

export const SOURCE_STATUSES = ["EXTRACTED", "PARTIAL", "NO_TEXT", "FAILED"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export type SourceLanguage = "ru" | "en" | "mixed" | "unknown";

export type FileSourceState = {
  fileId: string;
  filename: string;
  kind: string;
  sourceStatus: SourceStatus;
  language: SourceLanguage;
  pages: number | null;
  chunks: number;
  characters: number;
  extractionMethod: string;
  sourceHash: string;
};

const NO_TEXT = /\[no extractable text|no extractable text in this pdf\]/i;
const FAILED_NOTE = /extract failed|could not decompress|extraction failed/i;
const CONTRADICTION = [
  /pdf is unreadable/i,
  /pdf text (is )?unavailable/i,
  /cannot inspect (the )?(attachment|pdf|file)/i,
  /unable to (read|inspect) (the )?(pdf|attachment|file)/i,
  /text unavailable/i,
  /attachment is unreadable/i,
];

export function detectSourceLanguage(text: string): SourceLanguage {
  const cyr = (text.match(/[а-яё]/gi) ?? []).length;
  const lat = (text.match(/[a-z]/gi) ?? []).length;
  if (cyr === 0 && lat === 0) return "unknown";
  if (cyr > 0 && lat > 0 && Math.min(cyr, lat) / Math.max(cyr, lat) > 0.15) return "mixed";
  return cyr > lat ? "ru" : "en";
}

function methodFor(kind: string): string {
  if (kind === "PDF") return "pdf-text-v1";
  if (kind === "ZIP") return "zip-members-v1";
  return "utf8-text-v1";
}

export function classifyExtractedText(input: {
  kind: string;
  extractedText: string;
  notes?: string;
  persistedStatus?: string | null;
}): SourceStatus {
  const persisted = String(input.persistedStatus ?? "").toUpperCase();
  if ((SOURCE_STATUSES as readonly string[]).includes(persisted)) return persisted as SourceStatus;
  const text = input.extractedText ?? "";
  if (FAILED_NOTE.test(input.notes ?? "") && !text.trim()) return "FAILED";
  if (!text.trim() || NO_TEXT.test(text)) return "NO_TEXT";
  if (input.kind === "PDF" && text.trim().length < 40) return "PARTIAL";
  if (/\[skipped:/i.test(text) && text.replace(/\[skipped:[^\]]+\]/g, "").trim().length < 40) return "PARTIAL";
  return "EXTRACTED";
}

export function classifyFileSource(
  file: Pick<ProjectFile, "id" | "filename" | "kind" | "extractedText" | "notes" | "characterCount"> &
    Partial<Pick<ProjectFile, "sourceStatus" | "sourceLanguage" | "pageCount" | "chunkCount" | "extractionMethod" | "sourceHash">>,
  chunkCount?: number,
): FileSourceState {
  const text = file.extractedText ?? "";
  const sourceStatus = classifyExtractedText({
    kind: file.kind,
    extractedText: text,
    notes: file.notes,
    persistedStatus: file.sourceStatus,
  });
  const language = (file.sourceLanguage as SourceLanguage | null) || detectSourceLanguage(text);
  const characters = text.length || file.characterCount || 0;
  const chunks = file.chunkCount ?? chunkCount ?? (text.trim() ? text.split(/\n{2,}/).filter((row) => row.trim()).length || 1 : 0);
  const pages =
    file.pageCount ??
    (file.kind === "PDF" && sourceStatus === "EXTRACTED" ? Math.max(1, Math.ceil(characters / 1800)) : null);
  return {
    fileId: file.id,
    filename: file.filename,
    kind: file.kind,
    sourceStatus,
    language: language || "unknown",
    pages,
    chunks,
    characters,
    extractionMethod: file.extractionMethod || methodFor(file.kind),
    sourceHash: file.sourceHash || hashContent(text),
  };
}

export function stampProjectFile<T extends ProjectFile>(file: T): T {
  const state = classifyFileSource(file);
  return {
    ...file,
    sourceStatus: state.sourceStatus,
    sourceLanguage: state.language,
    pageCount: file.pageCount ?? state.pages,
    chunkCount: state.chunks,
    extractionMethod: state.extractionMethod,
    sourceHash: state.sourceHash,
  };
}

export function contradictsExtractedSource(text: string, states: FileSourceState[]): boolean {
  const extracted = states.some((row) => row.sourceStatus === "EXTRACTED");
  if (!extracted || !text.trim()) return false;
  return CONTRADICTION.some((pattern) => pattern.test(text));
}

/** Drop model claims that deny a file the system already extracted. */
export function scrubSourceContradictions(
  text: string,
  states: FileSourceState[],
): { text: string; contradicted: boolean } {
  if (!contradictsExtractedSource(text, states)) return { text, contradicted: false };
  const parts = text.split(/\n{2,}/);
  const kept = parts.filter((part) => !contradictsExtractedSource(part, states));
  const body = kept.join("\n\n").trim();
  const note = "MODEL_SOURCE_STATE_CONTRADICTION";
  return {
    text: body ? `${note}\n${body}` : note,
    contradicted: true,
  };
}
