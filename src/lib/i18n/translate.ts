import { maskTechnical, restoreTechnical } from "./preserve.ts";
import type { UiLanguage } from "./locale.ts";

export type TranslateRequest = {
  text: string;
  from: "ru" | "en" | "auto";
  to: UiLanguage;
};

export type TranslateFn = (input: TranslateRequest) => Promise<string>;

const TASK_SYSTEM = `You are a faithful translator. Translate the user text to English.
Rules:
- Do not summarize, omit, expand, or reinterpret.
- Preserve meaning exactly.
- Keep placeholders like ⟦T0⟧ unchanged.
- Keep code, identifiers, formulas, quoted text, filenames, citations, URLs, and technical terms unchanged.
- Return only the translation.`;

const RESULT_SYSTEM = `You are a faithful translator. Translate the user text to Russian.
Rules:
- Do not summarize, omit, expand, or reinterpret.
- Do not change verdicts, severity, issue ids, citations, model names, provider names, file paths, formulas, or API field names.
- Keep placeholders like ⟦T0⟧ unchanged.
- Use natural technical Russian, not word-for-word calque.
- Return only the translation.`;

export async function translateWithXai(input: TranslateRequest): Promise<string> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    const err = new Error("TRANSLATION_UNAVAILABLE");
    err.name = "TranslationUnavailable";
    throw err;
  }
  const { masked, tokens } = maskTechnical(input.text);
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: 0,
      max_tokens: 2048,
      messages: [
        { role: "system", content: input.to === "en" ? TASK_SYSTEM : RESULT_SYSTEM },
        { role: "user", content: masked },
      ],
    }),
  });
  if (!res.ok) {
    const err = new Error(`TRANSLATION_HTTP_${res.status}`);
    err.name = "TranslationFailed";
    throw err;
  }
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!raw) {
    const err = new Error("TRANSLATION_EMPTY");
    err.name = "TranslationFailed";
    throw err;
  }
  return restoreTechnical(raw, tokens);
}

export async function translateOrThrow(input: TranslateRequest, fn: TranslateFn = translateWithXai): Promise<string> {
  const text = input.text.trim();
  if (!text) return "";
  return fn({ ...input, text });
}
