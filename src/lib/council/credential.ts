/** Public credential metadata. Never includes the API secret. */

import { createHash } from "node:crypto";
import { maskKey, sanitizeApiKey } from "./api-key.ts";
import type { ProviderId } from "./types.ts";

export type CredentialValidation = "CONNECTED" | "FAILED" | "NOT_TESTED";

export type ProviderCredentialMeta = {
  fingerprint: string;
  last4: string;
  masked: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastValidation: CredentialValidation;
};

export type ProviderCredentialBag = Partial<Record<ProviderId, ProviderCredentialMeta>>;

export function last4Of(plain: string): string {
  const value = plain.trim();
  if (value.length < 4) return value;
  return value.slice(-4);
}

export function credentialFingerprint(plain: string): string {
  const value = plain.trim();
  if (!value) return "";
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

export function validationFromTest(ok: boolean | null | undefined): CredentialValidation {
  if (ok === true) return "CONNECTED";
  if (ok === false) return "FAILED";
  return "NOT_TESTED";
}

export function parseCredentialBag(value: unknown): ProviderCredentialBag {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  const out: ProviderCredentialBag = {};
  for (const id of ["nanogpt", "openrouter", "openrusrouter"] as const) {
    const row = rec[id];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const meta = row as Record<string, unknown>;
    const fingerprint = typeof meta.fingerprint === "string" ? meta.fingerprint : "";
    const last4 = typeof meta.last4 === "string" ? meta.last4 : "";
    const masked = typeof meta.masked === "string" ? meta.masked : "";
    const updatedAt = typeof meta.updatedAt === "string" ? meta.updatedAt : "";
    const lastValidatedAt = typeof meta.lastValidatedAt === "string" ? meta.lastValidatedAt : null;
    const lastValidation =
      meta.lastValidation === "CONNECTED" || meta.lastValidation === "FAILED" || meta.lastValidation === "NOT_TESTED"
        ? meta.lastValidation
        : "NOT_TESTED";
    out[id] = { fingerprint, last4, masked, updatedAt, lastValidatedAt, lastValidation };
  }
  return out;
}

export function metaFromPlaintext(
  plain: string,
  provider: ProviderId,
  at: string,
  validation: CredentialValidation,
  lastValidatedAt: string | null,
): ProviderCredentialMeta | null {
  const value = sanitizeApiKey(plain, provider);
  if (!value) return null;
  return {
    fingerprint: credentialFingerprint(value),
    last4: last4Of(value),
    masked: maskKey(value, provider),
    updatedAt: at,
    lastValidatedAt,
    lastValidation: validation,
  };
}

export function upsertCredentialMeta(
  bag: ProviderCredentialBag,
  provider: ProviderId,
  plain: string,
  at: string,
  validation: CredentialValidation,
  lastValidatedAt: string | null,
): ProviderCredentialBag {
  const next = { ...bag };
  if (!plain.trim()) {
    delete next[provider];
    return next;
  }
  const meta = metaFromPlaintext(plain, provider, at, validation, lastValidatedAt);
  if (!meta) {
    delete next[provider];
    return next;
  }
  const previous = bag[provider];
  next[provider] = {
    ...meta,
    updatedAt: previous?.updatedAt && previous.fingerprint === meta.fingerprint ? previous.updatedAt : at,
    lastValidatedAt: lastValidatedAt ?? previous?.lastValidatedAt ?? null,
    lastValidation: validation === "NOT_TESTED" && previous?.fingerprint === meta.fingerprint
      ? previous.lastValidation
      : validation,
  };
  return next;
}

export function stampSelectedValidation(
  bag: ProviderCredentialBag,
  provider: ProviderId,
  ok: boolean | null | undefined,
  at: string | null,
): ProviderCredentialBag {
  const current = bag[provider];
  if (!current) return bag;
  return {
    ...bag,
    [provider]: {
      ...current,
      lastValidation: validationFromTest(ok),
      lastValidatedAt: at ?? current.lastValidatedAt,
    },
  };
}
