/** Deterministic content identity. Sync so seed, paste, and tests share one path. */
export function hashContent(raw: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i) | 0;
    h2 = Math.imul(h2, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}:${raw.length}`;
}

export function estimateTokens(characterCount: number): number {
  return Math.max(1, Math.ceil(characterCount / 4));
}
