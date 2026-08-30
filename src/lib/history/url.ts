export type UrlValidation =
  | { ok: true; href: string }
  | { ok: false; error: string };

const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",
]);

function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isBlockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return isPrivateIPv4(h);
}

export function validateChatUrl(raw: string): UrlValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "A chat URL is required." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "The URL is not valid." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http and https chat URLs can be checked." };
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: "That address cannot be fetched from this app." };
  }
  return { ok: true, href: parsed.href };
}
