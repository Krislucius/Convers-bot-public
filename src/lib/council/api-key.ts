import { PROVIDERS, isProviderId, providerName, type ProviderMeta } from "./providers.ts";
import type { ProviderId } from "./types";

const INVISIBLE =
  // eslint-disable-next-line no-control-regex -- strip C0/C1/format chars from pasted keys
  /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F\u2060\u3000\uFEFF]/g;
const OPENROUTER_TOKEN = /sk-or-[A-Za-z0-9_-]+/i;
const OPENRUS_TOKEN = /orr_(?:live|test)_[A-Za-z0-9_-]+/i;

export function mergeStoredApiKeys(
  current: { openrouterKey: string; openrusrouterKey: string },
  input: { provider: ProviderId; apiKey?: string; clearKey?: boolean },
): { openrouterKey: string; openrusrouterKey: string } {
  let openrouterKey = current.openrouterKey;
  let openrusrouterKey = current.openrusrouterKey;
  if (input.clearKey) {
    if (input.provider === "openrusrouter") openrusrouterKey = "";
    else openrouterKey = "";
    return { openrouterKey, openrusrouterKey };
  }
  const next = sanitizeApiKey(input.apiKey ?? "", input.provider);
  if (!next) return { openrouterKey, openrusrouterKey };
  if (input.provider === "openrusrouter") openrusrouterKey = next;
  else openrouterKey = next;
  return { openrouterKey, openrusrouterKey };
}

export function detectProvider(raw: string): ProviderId | null {
  const cleaned = raw.replace(INVISIBLE, "");
  if (OPENRUS_TOKEN.test(cleaned)) return "openrusrouter";
  if (OPENROUTER_TOKEN.test(cleaned)) return "openrouter";
  return null;
}

export function sanitizeApiKey(raw: string, provider?: ProviderId): string {
  if (!raw) return "";
  let key = raw.replace(INVISIBLE, "");
  key = key.replace(/^['"`]+|['"`]+$/g, "");
  const assigned = key.match(
    /(?:OPENRUSROUTER_API_KEY|OPENROUTER_API_KEY|OR_API_KEY|API_KEY|api[_-]?key)\s*[=:]\s*(.+)$/i,
  );
  if (assigned?.[1]) {
    key = assigned[1].replace(/^['"`]+|['"`]+$/g, "");
  }
  key = key.replace(/^Bearer/i, "");
  const orr = key.match(OPENRUS_TOKEN);
  const openrouter = key.match(OPENROUTER_TOKEN);
  if (provider === "openrusrouter") {
    if (orr) return orr[0];
    return key.replace(/[^A-Za-z0-9_-]/g, "");
  }
  if (provider === "openrouter") {
    if (openrouter) return openrouter[0];
    return key.replace(/[^A-Za-z0-9_-]/g, "");
  }
  if (orr) return orr[0];
  if (openrouter) return openrouter[0];
  return key.replace(/[^A-Za-z0-9_-]/g, "");
}

export function looksMasked(raw: string): boolean {
  return /(sk-or-|orr_(?:live|test)_)/i.test(raw) && /(\.{3}|…|•{2,}|·{2,})/.test(raw);
}

export function maskKey(raw: string, provider?: ProviderId): string {
  const value = sanitizeApiKey(raw, provider);
  if (!value) return "";
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function keyFingerprint(raw: string, provider?: ProviderId): { chars: number; prefix: string } {
  const value = sanitizeApiKey(raw, provider);
  const prefix = /^orr_/i.test(value) ? value.slice(0, 9) : value.slice(0, 8);
  return {
    chars: value.length,
    prefix: prefix || (provider === "openrusrouter" ? "orr_live_" : "sk-or-v1"),
  };
}

export function describeKey(key: string, provider: ProviderId = "openrouter"): { ok: boolean; text: string } {
  if (!key.trim()) return { ok: false, text: "" };
  const meta = PROVIDERS[provider];
  if (looksMasked(key)) {
    return {
      ok: false,
      text: `That looks like a masked preview, not the secret. Create a new ${meta.name} key and copy the full ${meta.keyPrefix}… value immediately.`,
    };
  }
  const value = sanitizeApiKey(key, provider);
  const detected = detectProvider(key);
  if (detected && detected !== provider) {
    return {
      ok: false,
      text: `This looks like a ${providerName(detected)} key. Switch provider to ${providerName(detected)} or paste a ${meta.keyPrefix}… key.`,
    };
  }
  if (/^xai-/i.test(value)) {
    return {
      ok: false,
      text: `This looks like an xAI key. ${meta.name} keys start with ${meta.keyPrefix}.`,
    };
  }
  if (/^sk-proj-/i.test(value) || (/^sk-(?!or-)/i.test(value) && provider === "openrouter")) {
    return {
      ok: false,
      text: `This looks like an OpenAI key. Create a ${meta.name} key at ${meta.keysUrl.replace("https://", "")}.`,
    };
  }
  if (provider === "openrusrouter") {
    if (!/^orr_(?:live|test)_/i.test(value)) {
      return {
        ok: false,
        text: "OpenRusRouter keys start with orr_live_. OpenRouter, ChatGPT Plus, or Grok keys will not work here.",
      };
    }
    if (value.length < 20) {
      return {
        ok: false,
        text: `Too short (${value.length} characters). Paste the full orr_live_… secret from the cabinet.`,
      };
    }
    return {
      ok: true,
      text: `Looks like an OpenRusRouter key · ${value.length} characters`,
    };
  }
  if (!/^sk-or-/i.test(value)) {
    return {
      ok: false,
      text: "OpenRouter keys start with sk-or-v1-. ChatGPT Plus, Grok, or OpenRusRouter keys will not work here.",
    };
  }
  if (value.length < 48) {
    return {
      ok: false,
      text: `Too short (${value.length} characters). A real OpenRouter secret is usually 70+ characters. Paste the full key shown once at creation, not the dotted preview.`,
    };
  }
  return {
    ok: true,
    text: `Looks like an OpenRouter key · ${value.length} characters`,
  };
}

export function keyRejectedMessage(
  status: number,
  body: string,
  fingerprint?: { chars: number; prefix: string },
  provider: ProviderId = "openrouter",
): string {
  const meta: ProviderMeta = PROVIDERS[isProviderId(provider) ? provider : "openrouter"];
  const low = body.toLowerCase();
  const sent = Boolean(fingerprint && fingerprint.chars > 0);
  const size = sent ? ` The app sent ${fingerprint!.chars} characters starting with ${fingerprint!.prefix}.` : "";
  if (!sent && (low.includes("no cookie auth") || low.includes("no credentials") || low.includes("missing") || low.includes("отсутствующ"))) {
    return `The API key did not reach ${meta.name}. Paste the full key again and retry.`;
  }
  if (
    low.includes("user not found") ||
    low.includes("invalid") ||
    low.includes("неверн") ||
    low.includes("отсутствующ") ||
    status === 401 ||
    status === 403
  ) {
    return (
      `${meta.name} did not recognize this key.` +
      size +
      ` Create a new key at ${meta.keysUrl.replace("https://", "")} and copy the full ${meta.keyPrefix}… value.`
    );
  }
  return `${meta.name} rejected the API key. Check the key and try again.` + size;
}

export function redact(text: string, apiKey = ""): string {
  let out = text;
  const key = sanitizeApiKey(apiKey);
  if (key) out = out.split(key).join("[redacted]");
  return out
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/orr_(?:live|test)_[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/OPENROUTER_API_KEY/gi, "API key")
    .replace(/OPENRUSROUTER_API_KEY/gi, "API key");
}

export function extractErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const err = (payload as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return err.trim();
    if (err && typeof err === "object") {
      const message = (err as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
  }
  return `HTTP ${status}`;
}
