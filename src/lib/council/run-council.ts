import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { redact, sanitizeApiKey } from "./api-key";
import { isProviderId } from "./providers";
import type { ChatMessage, Completion, PreflightClientReport, ProviderCreds, ProviderId } from "./types";

function normalizeCreds(data: ProviderCreds): ProviderCreds {
  const provider: ProviderId = isProviderId(data.provider) ? data.provider : "openrouter";
  return {
    provider,
    apiKey: typeof data.apiKey === "string" ? sanitizeApiKey(data.apiKey, provider) : "",
    gptModel: String(data.gptModel ?? ""),
    grokModel: String(data.grokModel ?? ""),
    claudeModel: String(data.claudeModel ?? ""),
    maxCostUsd: Number(data.maxCostUsd) > 0 ? Number(data.maxCostUsd) : 1,
  };
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
    const mod =
      data.provider === "openrusrouter"
        ? await import("./openrusrouter.server")
        : await import("./openrouter.server");
    const report = await mod.preflightWithKey(creds);
    return {
      ok: report.ok,
      error: report.error ? redact(report.error, apiKey) : undefined,
      checks: report.checks,
      models: report.models,
      log: redact(report.log, apiKey),
    };
  });

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
    }): Promise<{ ok: true; completion: Completion } | { ok: false; error: string }> => {
      const provider: ProviderId = isProviderId(data.provider) ? data.provider : "openrouter";
      const { resolveStoredKey } = await import("./account.server");
      const apiKey = await resolveStoredKey(context.userId, provider, data.apiKey ?? "");
      const mod =
        provider === "openrusrouter"
          ? await import("./openrusrouter.server")
          : await import("./openrouter.server");
      if (!apiKey) {
        return { ok: false, error: "The AI provider is not connected. Save an API key on this account first." };
      }
      try {
        return {
          ok: true,
          completion: await mod.complete({ ...data, apiKey }),
        };
      } catch (err) {
        return { ok: false, error: mod.operatorError(err, apiKey) };
      }
    },
  );
