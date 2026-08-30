import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { loadAccountSettings, saveAccountSettings } from "./account";
import { sanitizeApiKey } from "./api-key";
import { DEFAULT_CLAUDE, DEFAULT_GPT, DEFAULT_GROK, DEFAULT_MAX_COST_USD, isProviderId } from "./providers";
import type { AccountSettingsPublic, ProviderCreds, ProviderId } from "./types";

export type { ProviderCreds, ProviderId };
export { DEFAULT_CLAUDE, DEFAULT_GPT, DEFAULT_GROK };

export type SessionConfig = {
  provider: ProviderId;
  gptModel: string;
  grokModel: string;
  claudeModel: string;
  maxCostUsd: number;
  ready: boolean;
  openrouter: { saved: boolean; masked: string };
  openrusrouter: { saved: boolean; masked: string };
};

type SessionApi = {
  config: SessionConfig;
  creds: ProviderCreds | null;
  hydrateFromAccount: (settings: AccountSettingsPublic) => void;
  setProvider: (provider: ProviderId) => void;
  save: (next: ProviderCreds) => Promise<AccountSettingsPublic>;
  clearKey: () => Promise<AccountSettingsPublic>;
};

const SessionContext = createContext<SessionApi | null>(null);

const emptySettings: AccountSettingsPublic = {
  provider: "openrouter",
  gptModel: DEFAULT_GPT,
  grokModel: DEFAULT_GROK,
  claudeModel: DEFAULT_CLAUDE,
  maxCostUsd: DEFAULT_MAX_COST_USD,
  openrouter: { saved: false, masked: "" },
  openrusrouter: { saved: false, masked: "" },
};

function fromPublic(settings: AccountSettingsPublic): SessionConfig {
  const provider = isProviderId(settings.provider) ? settings.provider : "openrouter";
  const slot = provider === "openrusrouter" ? settings.openrusrouter : settings.openrouter;
  return {
    provider,
    gptModel: settings.gptModel.trim() || DEFAULT_GPT,
    grokModel: settings.grokModel.trim() || DEFAULT_GROK,
    claudeModel: settings.claudeModel.trim() || DEFAULT_CLAUDE,
    maxCostUsd: settings.maxCostUsd > 0 ? settings.maxCostUsd : DEFAULT_MAX_COST_USD,
    ready: slot.saved,
    openrouter: settings.openrouter,
    openrusrouter: settings.openrusrouter,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SessionConfig>(() => fromPublic(emptySettings));

  const hydrateFromAccount = useCallback((settings: AccountSettingsPublic) => {
    setConfig(fromPublic(settings));
  }, []);

  const api = useMemo<SessionApi>(
    () => ({
      config,
      creds: config.ready
        ? {
            provider: config.provider,
            apiKey: "",
            gptModel: config.gptModel,
            grokModel: config.grokModel,
            claudeModel: config.claudeModel,
            maxCostUsd: config.maxCostUsd,
          }
        : null,
      hydrateFromAccount,
      setProvider: (provider) => {
        setConfig((prev) => {
          const next = { ...prev, provider, ready: (provider === "openrusrouter" ? prev.openrusrouter : prev.openrouter).saved };
          void saveAccountSettings({
            data: {
              provider,
              gptModel: next.gptModel,
              grokModel: next.grokModel,
              claudeModel: next.claudeModel,
              maxCostUsd: next.maxCostUsd,
            },
          }).then((saved) => setConfig(fromPublic(saved)));
          return next;
        });
      },
      save: async (next) => {
        const provider = isProviderId(next.provider) ? next.provider : "openrouter";
        const apiKey = sanitizeApiKey(next.apiKey, provider);
        const saved = await saveAccountSettings({
          data: {
            provider,
            ...(apiKey ? { apiKey } : {}),
            gptModel: next.gptModel.trim() || DEFAULT_GPT,
            grokModel: next.grokModel.trim() || DEFAULT_GROK,
            claudeModel: next.claudeModel.trim() || DEFAULT_CLAUDE,
            maxCostUsd: next.maxCostUsd > 0 ? next.maxCostUsd : DEFAULT_MAX_COST_USD,
          },
        });
        setConfig(fromPublic(saved));
        return saved;
      },
      clearKey: async () => {
        const saved = await saveAccountSettings({
          data: {
            provider: config.provider,
            gptModel: config.gptModel,
            grokModel: config.grokModel,
            claudeModel: config.claudeModel,
            maxCostUsd: config.maxCostUsd,
            clearKey: true,
          },
        });
        setConfig(fromPublic(saved));
        return saved;
      },
    }),
    [config, hydrateFromAccount],
  );

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export async function refreshAccountSettings(): Promise<AccountSettingsPublic> {
  return loadAccountSettings();
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("SessionProvider missing");
  return ctx;
}
