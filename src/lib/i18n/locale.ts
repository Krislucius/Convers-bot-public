export const UI_LANGUAGES = ["en", "ru"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export type SourceLanguage = "en" | "ru" | "mixed";

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";
export const LANGUAGE_STORAGE_KEY = "cb-ui-language";

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "ru";
}

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return isUiLanguage(value) ? value : DEFAULT_UI_LANGUAGE;
}

const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[A-Za-z]/g;

export function detectSourceLanguage(text: string): SourceLanguage {
  const raw = String(text ?? "");
  const cyr = raw.match(CYRILLIC_RE)?.length ?? 0;
  const lat = raw.match(LATIN_RE)?.length ?? 0;
  if (cyr === 0) return "en";
  if (lat === 0) return "ru";
  const total = cyr + lat;
  if (cyr / total < 0.08) return "en";
  if (lat / total >= 0.12 && cyr / total >= 0.12) return "mixed";
  return "ru";
}

export function needsEnglishCanonical(source: SourceLanguage): boolean {
  return source === "ru" || source === "mixed";
}
