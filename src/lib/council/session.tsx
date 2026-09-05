import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { loadAccountSettings, saveAccountSettings } from "./account";
import { sanitizeApiKey } from "./api-key";
import { runWithPersistRetry } from "./persist-queue";
import { runCredsFromReady } from "./orchestrate";
import { coerceMembers, membersFromIds, type CouncilMember } from "./members";
import { pruneToAvailable } from "./discover";
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_PROVIDER,
  isProviderId,
  slotFor,
} from "./providers";
import type { AccountSettingsPublic, DiscoverySnapshot, ProviderCreds, ProviderId } from "./types";

export type { ProviderCreds, ProviderId };

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
  lastTestLog: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
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
  save: (
    next: ProviderCreds & {
      selectedModelIds?: string[];
      catalog?: DiscoverySnapshot | null;
      lastTestLog?: string;
      lastTestAt?: string | null;
      lastTestOk?: boolean | null;
    },
  ) => Promise<AccountSettingsPublic>;
  clearKey: () => Promise<AccountSettingsPublic>;
};

const SessionContext = createContext<SessionApi | null>(null);

const emptySettings: AccountSettingsPublic = {
  provider: DEFAULT_PROVIDER,
  selectedModelIds: [],
  synthesizerModel: "",
  catalog: null,
  gptModel: "",
  grokModel: "",
  claudeModel: "",
  maxCostUsd: DEFAULT_MAX_COST_USD,
  lastTestLog: "",
  lastTestAt: null,
  lastTestOk: null,
  nanogpt: { saved: false, masked: "" },
  openrouter: { saved: false, masked: "" },
  openrusrouter: { saved: false, masked: "" },
};

function fromPublic(settings: AccountSettingsPublic): SessionConfig {
  const provider = isProviderId(settings.provider) ? settings.provider : DEFAULT_PROVIDER;
  const slot = slotFor(settings, provider);
  const catalog = settings.catalog ?? null;
  const selectedModelIds = catalog?.models?.length
    ? pruneToAvailable(settings.selectedModelIds ?? [], catalog.models)
    : (settings.selectedModelIds ?? []).filter(Boolean);
  const members = coerceMembers({
    selectedModelIds,
    catalog: catalog?.models,
  });
  return {
    provider,
    selectedModelIds: members.map((row) => row.modelId),
    synthesizerModel: selectedModelIds.includes(settings.synthesizerModel ?? "")
      ? settings.synthesizerModel
      : "",
    catalog,
    members,
    gptModel: members[0]?.modelId || "",
    grokModel: members[1]?.modelId || "",
    claudeModel: members[2]?.modelId || "",
    maxCostUsd: settings.maxCostUsd > 0 ? settings.maxCostUsd : DEFAULT_MAX_COST_USD,
    lastTestLog: settings.lastTestLog ?? "",
    lastTestAt: settings.lastTestAt ?? null,
    lastTestOk: settings.lastTestOk ?? null,
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
            lastTestLog: "",
            lastTestAt: null,
            lastTestOk: null,
          };
          void runWithPersistRetry(() =>
            saveAccountSettings({
              data: {
                provider,
                selectedModelIds: [],
                synthesizerModel: "",
                catalog: null,
                gptModel: "",
                grokModel: "",
                claudeModel: "",
                maxCostUsd: next.maxCostUsd,
                lastTestLog: "",
                lastTestAt: null,
                lastTestOk: null,
              },
            }),
          ).then((saved) => setConfig(fromPublic(saved)));
          return next;
        });
      },
      save: async (next) => {
        const provider = isProviderId(next.provider) ? next.provider : DEFAULT_PROVIDER;
        const apiKey = sanitizeApiKey(next.apiKey, provider);
        const catalog = next.catalog === undefined ? config.catalog : next.catalog;
        const members = coerceMembers({
          members: next.members,
          selectedModelIds: next.selectedModelIds,
          catalog: catalog?.models,
        });
        const selectedModelIds = members.map((row) => row.modelId);
        const saved = await runWithPersistRetry(() =>
          saveAccountSettings({
            data: {
              provider,
              ...(apiKey ? { apiKey } : {}),
              selectedModelIds,
              synthesizerModel: selectedModelIds.includes(next.synthesizerModel) ? next.synthesizerModel : "",
              catalog,
              gptModel: selectedModelIds[0] || "",
              grokModel: selectedModelIds[1] || "",
              claudeModel: selectedModelIds[2] || "",
              maxCostUsd: next.maxCostUsd > 0 ? next.maxCostUsd : DEFAULT_MAX_COST_USD,
              lastTestLog: next.lastTestLog,
              lastTestAt: next.lastTestAt,
              lastTestOk: next.lastTestOk,
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
              lastTestLog: config.lastTestLog,
              lastTestAt: config.lastTestAt,
              lastTestOk: config.lastTestOk,
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
