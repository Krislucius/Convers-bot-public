import { detectSourceLanguage, needsEnglishCanonical, type SourceLanguage } from "./locale.ts";
import { extractCitations } from "./preserve.ts";
import { translateOrThrow, type TranslateFn } from "./translate.ts";

export type PreparedTaskText = {
  originalTitle: string;
  title: string;
  originalTask: string;
  canonicalTaskEn: string;
  sourceLanguage: SourceLanguage;
};

function sameCitations(a: string, b: string): boolean {
  const left = extractCitations(a).join("\n");
  const right = extractCitations(b).join("\n");
  return left === right;
}

export async function prepareTaskText(
  input: { title: string; prompt: string },
  translate: TranslateFn,
): Promise<PreparedTaskText> {
  const originalTitle = input.title.trim();
  const originalTask = input.prompt.trim();
  const combined = `${originalTitle}\n${originalTask}`;
  const sourceLanguage = detectSourceLanguage(combined);

  if (!needsEnglishCanonical(sourceLanguage)) {
    return {
      originalTitle,
      title: originalTitle,
      originalTask,
      canonicalTaskEn: originalTask,
      sourceLanguage: "en",
    };
  }

  const canonicalTaskEn = (await translateOrThrow({ text: originalTask, from: "auto", to: "en" }, translate)).trim();
  const titleNeeds = needsEnglishCanonical(detectSourceLanguage(originalTitle));
  const title = titleNeeds
    ? (await translateOrThrow({ text: originalTitle, from: "auto", to: "en" }, translate)).trim() || originalTitle
    : originalTitle;

  if (!canonicalTaskEn) {
    const err = new Error("TRANSLATION_EMPTY");
    err.name = "TranslationFailed";
    throw err;
  }
  if (!sameCitations(originalTask, canonicalTaskEn)) {
    const err = new Error("TRANSLATION_CITATION_DRIFT");
    err.name = "TranslationFailed";
    throw err;
  }

  return {
    originalTitle,
    title,
    originalTask,
    canonicalTaskEn,
    sourceLanguage,
  };
}

export function councilTaskText(task: {
  prompt: string;
  canonicalTaskEn?: string | null;
}): string {
  return (task.canonicalTaskEn || task.prompt || "").trim();
}
