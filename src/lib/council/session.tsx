import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { loadAccountSettings, saveAccountSettings } from "./account";
import { sanitizeApiKey } from "./api-key";
import { runWithPersistRetry } from "./persist-queue";
import { runCredsFromReady } from "./orchestrate";
import { coerceMembers, membersFromIds, type CouncilMember } from "./members";
import {
  DEFAULT_CLAUDE,
  DEFAULT_GPT,
  DEFAULT_GROK,
  DEFAULT_MAX_COST_USD,
  DEFAULT_PROVIDER,
  isProviderId,
  slotFor,
} from "./providers";
import type { AccountSettingsPublic, DiscoverySnapshot, ProviderCreds, ProviderId } from "./types";

export type { ProviderCreds, ProviderId };
export { DEFAULT_CLAUDE, DEFAULT_GPT, DEFAULT_GROK };

export type SessionConfig = {
  provider: ProviderId;
  selectedModelIds: string[];
  synthesizerModel: string;
  catalog: DiscoverySnapshot | null;
  members: CouncilMember[];
  gptModel: string;
  grokModel: string;
  claudeModel: string;
  maxCostUsd: number;
  ready: boolean;
  nanogpt: { saved: boolean; masked: string };
  openrouter: { saved: boolean; masked: string };
  openrusrouter: { saved: boolean; masked: string };
};

type SessionApi = {
  config: SessionConfig;
  creds: ProviderCreds | null;
  hydrateFromAccount: (settings: AccountSettingsPublic) => void;
  setProvider: (provider: ProviderId) => void;
  save: (next: ProviderCreds & { selectedModelIds?: string[]; catalog?: DiscoverySnapshot | null }) => Promise<AccountSettingsPublic>;
  clearKey: () => Promise<AccountSettingsPublic>;
};

const SessionContext = createContext<SessionApi | null>(null);

const emptySettings: AccountSettingsPublic = {
  provider: DEFAULT_PROVIDER,
  selectedModelIds: [DEFAULT_GPT, DEFAULT_GROK, DEFAULT_CLAUDE],
  synthesizerModel: "",
  catalog: null,
  gptModel: DEFAULT_GPT,
  grokModel: DEFAULT_GROK,
  claudeModel: DEFAULT_CLAUDE,
  maxCostUsd: DEFAULT_MAX_COST_USD,
  nanogpt: { saved: false, masked: "" },
  openrouter: { saved: false, masked: "" },
  openrusrouter: { saved: false, masked: "" },
};

function fromPublic(settings: AccountSettingsPublic): SessionConfig {
  const provider = isProviderId(settings.provider) ? settings.provider : DEFAULT_PROVIDER;
  const slot = slotFor(settings, provider);
  const selectedModelIds =
    settings.selectedModelIds?.length >= 2
      ? settings.selectedModelIds
      : [settings.gptModel, settings.grokModel, settings.claudeModel].map((id) => id.trim()).filter(Boolean);
  const members = coerceMembers({
    selectedModelIds,
    catalog: settings.catalog?.models,
    gptModel: settings.gptModel,
    grokModel: settings.grokModel,
    claudeModel: settings.claudeModel,
  });
  return {
    provider,
    selectedModelIds: members.map((row) => row.modelId),
    synthesizerModel: settings.synthesizerModel ?? "",
    catalog: settings.catalog ?? null,
    members,
    gptModel: members[0]?.modelId || settings.gptModel.trim() || DEFAULT_GPT,
    grokModel: members[1]?.modelId || settings.grokModel.trim() || DEFAULT_GROK,
    claudeModel: members[2]?.modelId || settings.claudeModel.trim() || DEFAULT_CLAUDE,
    maxCostUsd: settings.maxCostUsd > 0 ? settings.maxCostUsd : DEFAULT_MAX_COST_USD,
    ready: slot.saved,
    nanogpt: settings.nanogpt,
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
      creds: runCredsFromReady(config),
      hydrateFromAccount,
      setProvider: (provider) => {
        setConfig((prev) => {
          const next = {
            ...prev,
            provider,
            ready: slotFor(prev, provider).saved,
            catalog: null,
            selectedModelIds: [],
            members: [],
            synthesizerModel: "",
          };
          void runWithPersistRetry(() =>
            saveAccountSettings({
              data: {
                provider,
                selectedModelIds: [],
                synthesizerModel: "",
                catalog: null,
                gptModel: next.gptModel,
                grokModel: next.grokModel,
                claudeModel: next.claudeModel,
                maxCostUsd: next.maxCostUsd,
              },
            }),
          ).then((saved) => setConfig(fromPublic(saved)));
          return next;
        });
      },
      save: async (next) => {
        const provider = isProviderId(next.provider) ? next.provider : DEFAULT_PROVIDER;
        const apiKey = sanitizeApiKey(next.apiKey, provider);
        const members = coerceMembers({
          members: next.members,
          selectedModelIds: next.selectedModelIds,
          catalog: next.catalog?.models ?? config.catalog?.models,
        });
        const selectedModelIds = members.map((row) => row.modelId);
        const saved = await runWithPersistRetry(() =>
          saveAccountSettings({
            data: {
              provider,
              ...(apiKey ? { apiKey } : {}),
              selectedModelIds,
              synthesizerModel: next.synthesizerModel,
              catalog: next.catalog === undefined ? config.catalog : next.catalog,
              gptModel: selectedModelIds[0] || DEFAULT_GPT,
              grokModel: selectedModelIds[1] || DEFAULT_GROK,
              claudeModel: selectedModelIds[2] || DEFAULT_CLAUDE,
              maxCostUsd: next.maxCostUsd > 0 ? next.maxCostUsd : DEFAULT_MAX_COST_USD,
            },
          }),
        );
        setConfig(fromPublic(saved));
        return saved;
      },
      clearKey: async () => {
        const saved = await runWithPersistRetry(() =>
          saveAccountSettings({
            data: {
              provider: config.provider,
              selectedModelIds: config.selectedModelIds,
              synthesizerModel: config.synthesizerModel,
              catalog: config.catalog,
              gptModel: config.gptModel,
              grokModel: config.grokModel,
              claudeModel: config.claudeModel,
              maxCostUsd: config.maxCostUsd,
              clearKey: true,
            },
          }),
        );
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

export { membersFromIds };
