/**
 * Deterministic Council token estimator shared by packing and UI estimates.
 * Not a vendor tokenizer. Wide code points (CJK, kana, hangul, emoji, fullwidth)
 * count as 1 token each. Other non-whitespace runs count as ceil(UTF-16 length / 4).
 * Whitespace is not counted. Never used to slice packed text.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    const size = cp > 0xffff ? 2 : 1;
    if (isWhitespace(cp)) {
      i += size;
      continue;
    }
    if (isWide(cp)) {
      n += 1;
      i += size;
      continue;
    }
    const start = i;
    i += size;
    while (i < text.length) {
      const next = text.codePointAt(i) ?? 0;
      if (isWhitespace(next) || isWide(next)) break;
      i += next > 0xffff ? 2 : 1;
    }
    n += Math.max(1, Math.ceil((i - start) / 4));
  }
  return n;
}

export function fitsTokenBudget(text: string, budget: number): boolean {
  return countTokens(text) <= budget;
}

function isWhitespace(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0x0d ||
    cp === 0x20 ||
    cp === 0xa0 ||
    cp === 0x3000
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x1f600 && cp <= 0x1f64f)
  );
}
