export type TechnicalMask = {
  masked: string;
  tokens: string[];
};

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const CITATION_RE = /\[[A-Z][A-Z0-9_]*:[^\]]+\]/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+/g;
const PATH_RE = /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|md|py|go|rs|css|html)\b/g;
const FORMULA_RE = /\$[^$\n]+\$/g;
const ENUM_RE = /\b[A-Z][A-Z0-9_]{2,}\b/g;

function collect(text: string, pattern: RegExp, into: string[]): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const value = match[0];
    if (value && !into.includes(value)) into.push(value);
  }
}

export function maskTechnical(text: string): TechnicalMask {
  const tokens: string[] = [];
  collect(text, FENCE_RE, tokens);
  collect(text, INLINE_CODE_RE, tokens);
  collect(text, CITATION_RE, tokens);
  collect(text, URL_RE, tokens);
  collect(text, PATH_RE, tokens);
  collect(text, FORMULA_RE, tokens);
  collect(text, ENUM_RE, tokens);
  tokens.sort((a, b) => b.length - a.length);
  let masked = text;
  tokens.forEach((token, index) => {
    masked = masked.split(token).join(`⟦T${index}⟧`);
  });
  return { masked, tokens };
}

export function restoreTechnical(text: string, tokens: string[]): string {
  let out = text;
  tokens.forEach((token, index) => {
    out = out.split(`⟦T${index}⟧`).join(token);
    out = out.split(`[T${index}]`).join(token);
  });
  return out;
}

export function extractCitations(text: string): string[] {
  return text.match(CITATION_RE) ?? [];
}
