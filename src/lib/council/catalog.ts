import { providerName } from "./providers.ts";
import type { ProviderId } from "./types.ts";

export const MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE";
export const MODEL_UNAVAILABLE_ON_PROVIDER = MODEL_UNAVAILABLE;

export type CatalogCheckResult = {
  ok: boolean;
  error?: string;
  code?: "MODEL_UNAVAILABLE" | "MODEL_UNAVAILABLE_ON_PROVIDER" | "PROVIDER_UNREACHABLE" | "KEY_REJECTED";
  missing: string[];
  available: string[];
};

export function unavailableOnProvider(provider: ProviderId, missing: string[]): string {
  const models = missing.filter(Boolean).join(", ") || "required model";
  return `${MODEL_UNAVAILABLE}: ${models} is not available on ${providerName(provider)}. Refresh models and pick a replacement in API Settings.`;
}

export function catalogFromIds(
  provider: ProviderId,
  requested: string[],
  known: Set<string>,
): CatalogCheckResult {
  const missing = requested.filter((id) => id && (known.size === 0 || !known.has(id)));
  if (known.size === 0) {
    return {
      ok: false,
      code: "PROVIDER_UNREACHABLE",
      error: `${providerName(provider)} model catalog was empty. Council did not start paid calls.`,
      missing: requested.filter(Boolean),
      available: [],
    };
  }
  if (missing.length) {
    return {
      ok: false,
      code: MODEL_UNAVAILABLE,
      error: unavailableOnProvider(provider, missing),
      missing,
      available: [...known],
    };
  }
  return { ok: true, missing: [], available: [...known] };
}
