import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { redact, sanitizeApiKey } from "./api-key";
import { catalogFromIds, type CatalogCheckResult } from "./catalog";
import { coerceMembers } from "./members";
import { isProviderId, normalizeProviderId } from "./providers";
import type { ChatMessage, Completion, PreflightClientReport, ProviderCreds, ProviderId } from "./types";
import type { ProviderFailure } from "./provider-error";
import type { DiscoverySnapshot } from "./discover";

function normalizeCreds(data: ProviderCreds & {
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  selectedIds?: string[];
}): ProviderCreds {
  const provider: ProviderId = isProviderId(data.provider) ? data.provider : "nanogpt";
  const members = coerceMembers(data);
  return {
    provider,
    apiKey: typeof data.apiKey === "string" ? sanitizeApiKey(data.apiKey, provider) : "",
    members,
    synthesizerModel: String(data.synthesizerModel ?? ""),
    maxCostUsd: Number(data.maxCostUsd) > 0 ? Number(data.maxCostUsd) : 1,
  };
}

function requestedModels(data: {
  models?: string[];
  members?: ProviderCreds["members"];
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  selectedIds?: string[];
}): string[] {
  if (data.models?.length) return data.models.map((id) => id.trim()).filter(Boolean);
  return coerceMembers(data).map((row) => row.modelId);
}

async function loadProvider(id: ProviderId) {
  if (id === "openrusrouter") return import("./openrusrouter.server");
  if (id === "openrouter") return import("./openrouter.server");
  return import("./nanogpt.server");
}

export const testProvider = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: ProviderCreds) => {
    if (!data) {
      throw new Error("The AI provider is not connected. Connect your API key before running the Council.");
    }
    return normalizeCreds(data);
  })
  .handler(async ({ context, data }): Promise<PreflightClientReport> => {
    const { resolveStoredKey } = await import("./account.server");
    const apiKey = await resolveStoredKey(context.userId, data.provider, data.apiKey);
    if (!apiKey) {
      throw new Error("The AI provider is not connected. Save an API key on this account first.");
    }
    const creds = { ...data, apiKey };
    const mod = await loadProvider(data.provider);
    const discovered = await mod.discoverAccount(apiKey, creds.members.map((row) => row.modelId));
    return {
      ok: discovered.ok,
      error: discovered.error ? redact(discovered.error, apiKey) : undefined,
      checks: discovered.checks,
      models: Object.fromEntries(
        (discovered.snapshot?.recommendedIds ?? []).map((id, index) => [`m${index + 1}`, id]),
      ),
      log: redact(discovered.log || "", apiKey),
      catalog: discovered.snapshot ?? undefined,
    };
  });

export const discoverModels = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { provider?: ProviderId; apiKey?: string; selectedIds?: string[] }) => data)
  .handler(
    async ({
      context,
      data,
    }): Promise<{
      ok: boolean;
      error?: string;
      catalog: DiscoverySnapshot | null;
      checks: PreflightClientReport["checks"];
      log: string;
    }> => {
      const provider = normalizeProviderId(data.provider);
      const { resolveStoredKey } = await import("./account.server");
      const apiKey = await resolveStoredKey(context.userId, provider, data.apiKey ?? "");
      if (!apiKey) {
        return {
          ok: false,
          error: "The AI provider is not connected. Save an API key on this account first.",
          catalog: null,
          checks: {},
          log: "",
        };
      }
      const mod = await loadProvider(provider);
      const discovered = await mod.discoverAccount(apiKey, data.selectedIds ?? []);
      return {
        ok: discovered.ok,
        error: discovered.error ? redact(discovered.error, apiKey) : undefined,
        catalog: discovered.snapshot,
        checks: discovered.checks,
        log: redact(discovered.log, apiKey),
      };
    },
  );

export const checkCatalog = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      provider?: ProviderId;
      apiKey?: string;
      models?: string[];
      gptModel?: string;
      grokModel?: string;
      claudeModel?: string;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<CatalogCheckResult> => {
    const provider = normalizeProviderId(data.provider);
    const models = requestedModels(data);
    const { resolveStoredKey } = await import("./account.server");
    const apiKey = await resolveStoredKey(context.userId, provider, data.apiKey ?? "");
    if (!apiKey) {
      return {
        ok: false,
        code: "KEY_REJECTED",
        error: "The AI provider is not connected. Save an API key on this account first.",
        missing: models,
        available: [],
      };
    }
    const mod = await loadProvider(provider);
    const result = await mod.catalogCheck({ apiKey, models });
    return {
      ...result,
      error: result.error ? redact(result.error, apiKey) : undefined,
      available: result.available ?? [],
      missing: result.missing ?? [],
    };
  });

export const checkAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { provider?: ProviderId; apiKey?: string; models: string[] }) => data)
  .handler(
    async ({
      context,
      data,
    }): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }> => {
      const provider = normalizeProviderId(data.provider);
      const { resolveStoredKey } = await import("./account.server");
      const apiKey = await resolveStoredKey(context.userId, provider, data.apiKey ?? "");
      if (!apiKey) {
        return {
          ok: false,
          blocked: data.models.map((id) => ({ id, access: "UNAVAILABLE" })),
          error: "The AI provider is not connected. Save an API key on this account first.",
        };
      }
      const mod = await loadProvider(provider);
      const result = await mod.accessCheck({ apiKey, models: data.models });
      return {
        ok: result.ok,
        blocked: result.blocked,
        error: result.error ? redact(result.error, apiKey) : undefined,
      };
    },
  );

export const completeChat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      provider?: ProviderId;
      apiKey?: string;
      model: string;
      messages: ChatMessage[];
      maxTokens: number;
      temperature: number;
      responseFormat?: Record<string, unknown>;
    }) => data,
  )
  .handler(
    async ({
      context,
      data,
    }): Promise<{ ok: true; completion: Completion } | { ok: false; error: string; failure?: ProviderFailure }> => {
      const provider: ProviderId = isProviderId(data.provider) ? data.provider : "nanogpt";
      const { resolveStoredKey } = await import("./account.server");
      const apiKey = await resolveStoredKey(context.userId, provider, data.apiKey ?? "");
      const mod = await loadProvider(provider);
      if (!apiKey) {
        return { ok: false, error: "The AI provider is not connected. Save an API key on this account first." };
      }
      try {
        return {
          ok: true,
          completion: await mod.complete({ ...data, apiKey }),
        };
      } catch (err) {
        const { toProviderFailure, formatProviderFailure } = await import("./provider-error");
        const failure = toProviderFailure(err, { provider, model: data.model, stage: "complete" }, apiKey);
        return { ok: false, error: formatProviderFailure(failure), failure };
      }
    },
  );

export { catalogFromIds };
