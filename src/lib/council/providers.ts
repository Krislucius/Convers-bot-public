import type { ProviderId } from "./types";

export type ProviderMeta = {
  id: ProviderId;
  name: string;
  keysUrl: string;
  keyPrefix: string;
  placeholder: string;
  help: string;
};

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    keysUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-v1-",
    placeholder: "sk-or-v1-••••••••••••••••••••",
    help: "Copy the full sk-or-v1-… value shown once. The dotted line in the keys table is not the secret.",
  },
  openrusrouter: {
    id: "openrusrouter",
    name: "OpenRusRouter",
    keysUrl: "https://openrusrouter.ru/cabinet/keys",
    keyPrefix: "orr_live_",
    placeholder: "orr_live_••••••••••••••••••••",
    help: "Create a key in the OpenRusRouter cabinet and paste the full orr_live_… value. This is a separate service from OpenRouter.",
  },
};

export const PROVIDER_IDS: ProviderId[] = ["openrouter", "openrusrouter"];

export const DEFAULT_GPT = "openai/gpt-5.6-sol";
export const DEFAULT_GROK = "x-ai/grok-4.6";
export const DEFAULT_CLAUDE = "anthropic/claude-sonnet-5";
export const DEFAULT_MAX_COST_USD = 1;

export function isProviderId(value: unknown): value is ProviderId {
  return value === "openrouter" || value === "openrusrouter";
}

export function providerName(id: ProviderId | string | undefined): string {
  if (id === "openrusrouter") return PROVIDERS.openrusrouter.name;
  return PROVIDERS.openrouter.name;
}
