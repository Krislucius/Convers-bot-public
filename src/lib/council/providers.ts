import type { ProviderId } from "./types";
import { attemptLimit, expectedSuccessfulCalls } from "./members.ts";

export type ProviderMeta = {
  id: ProviderId;
  name: string;
  keysUrl: string;
  keyPrefix: string;
  placeholder: string;
  help: string;
};

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  nanogpt: {
    id: "nanogpt",
    name: "NanoGPT",
    keysUrl: "https://nano-gpt.com/api",
    keyPrefix: "sk-nano-",
    placeholder: "sk-nano-••••••••••••••••••••",
    help: "Create a NanoGPT key and paste the full sk-nano-… value shown once. Council uses the models you select from this account.",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    keysUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    placeholder: "sk-or-v1-••••••••••••••••••••",
    help: "Create an OpenRouter key and paste the full sk-or-v1-… value. Council uses the models you select from this account.",
  },
  openrusrouter: {
    id: "openrusrouter",
    name: "OpenRusRouter",
    keysUrl: "https://openrusrouter.ru/cabinet/keys",
    keyPrefix: "orr_live_",
    placeholder: "orr_live_••••••••••••••••••••",
    help: "Create a key in the OpenRusRouter cabinet and paste the full orr_live_… value. This is a separate service from NanoGPT and OpenRouter.",
  },
};

/** Settings / Council setup selector order. OpenRusRouter stays available for existing keys. */
export const PROVIDER_IDS: ProviderId[] = ["nanogpt", "openrouter", "openrusrouter"];

export const DEFAULT_PROVIDER: ProviderId = "nanogpt";
export const DEFAULT_GPT = "openai/gpt-5.6-sol";
export const DEFAULT_GROK = "x-ai/grok-4.6";
export const DEFAULT_CLAUDE = "anthropic/claude-sonnet-5";
export const DEFAULT_MAX_COST_USD = 1;
export const EXPECTED_SUCCESSFUL_CALLS = expectedSuccessfulCalls(3);
export const MAX_PROVIDER_ATTEMPTS = attemptLimit(3);

export function isProviderId(value: unknown): value is ProviderId {
  return value === "nanogpt" || value === "openrouter" || value === "openrusrouter";
}

export function providerName(id: ProviderId | string | undefined): string {
  if (id === "openrouter") return PROVIDERS.openrouter.name;
  if (id === "openrusrouter") return PROVIDERS.openrusrouter.name;
  return PROVIDERS.nanogpt.name;
}

export function normalizeProviderId(value: unknown): ProviderId {
  return isProviderId(value) ? value : DEFAULT_PROVIDER;
}

export type KeySlot = { saved: boolean; masked: string };

export function emptyKeySlot(): KeySlot {
  return { saved: false, masked: "" };
}

export function slotFor<T extends { nanogpt: KeySlot; openrouter: KeySlot; openrusrouter: KeySlot }>(
  settings: T,
  provider: ProviderId,
): KeySlot {
  if (provider === "openrouter") return settings.openrouter;
  if (provider === "openrusrouter") return settings.openrusrouter;
  return settings.nanogpt;
}
