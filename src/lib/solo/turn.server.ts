import { loadSnapshot, loadPublicSettings, resolveStoredKey } from "@/lib/council/account.server";
import { isRetryableFailure, toProviderFailure } from "@/lib/council/provider-error";
import type { ProviderId } from "@/lib/council/types";
import { indexSelectedRepositories } from "@/lib/evidence/repo-index";
import { executeSoloTurn, type SoloThread } from "./logic.ts";
import { recordSoloCall, soloCancelled } from "./store.server.ts";

async function providerModule(provider: ProviderId) {
  if (provider === "openrouter") return import("@/lib/council/openrouter.server");
  if (provider === "openrusrouter") return import("@/lib/council/openrusrouter.server");
  return import("@/lib/council/nanogpt.server");
}

export async function runSoloTurn(userId: string, thread: SoloThread, input: { userText?: string; regenerate?: boolean }): Promise<{ thread: SoloThread; error: string | null; calls: number }> {
  const settings = await loadPublicSettings(userId);
  const snap = await loadSnapshot(userId);
  const project = snap.projects.find((row) => row.id === thread.projectId);
  const files = snap.projectFiles.filter((row) => thread.selectedFileIds.includes(row.id) && row.projectId === thread.projectId);
  const chats = snap.chatSources
    .filter((row) => thread.selectedChatIds.includes(row.id) && row.projectId === thread.projectId)
    .map((row) => ({ id: row.id, title: row.title, text: row.rawContent.slice(0, 8000) }));
  const artifacts = snap.artifacts
    .filter((row) => thread.selectedArtifactIds.includes(row.id) && row.projectId === thread.projectId)
    .map((row) => ({ id: row.id, title: row.title, content: row.content.slice(0, 8000) }));
  const repository =
    thread.contextEnabled && files.length
      ? indexSelectedRepositories({ files, designMentions: [] }).rows.map((row) => `${row.module} ${row.status}`)
      : [];
  const apiKey = await resolveStoredKey(userId, thread.provider, "");
  const mod = await providerModule(thread.provider);
  const billing = thread.provider === "nanogpt" ? settings.nanogptBilling : undefined;
  const result = await executeSoloTurn({
    thread,
    userText: input.userText,
    regenerate: input.regenerate,
    now: new Date().toISOString(),
    cancelled: () => false,
    context: {
      instructions: project?.description ?? "",
      chats,
      files,
      artifacts,
      repositoryLines: repository,
    },
    preflight: async (_provider, modelId) => {
      if (!apiKey) return { ok: false, error: "PROVIDER_NOT_CONNECTED" };
      const access = await mod.accessCheck({ apiKey, models: [modelId], nanogptBilling: billing });
      const blocked = access.blocked?.some((row) => row.id === modelId);
      if (!access.ok || blocked) return { ok: false, error: access.error || "MODEL_UNAVAILABLE" };
      return { ok: true };
    },
    retryable: (error) => isRetryableFailure(toProviderFailure(error, { provider: thread.provider, model: thread.modelId, stage: "solo" }, apiKey)),
    complete: async (request) => {
      if (request.modelId !== thread.modelId || request.provider !== thread.provider) {
        throw new Error("MODEL_SUBSTITUTION_FORBIDDEN");
      }
      if (await soloCancelled(userId, thread.id)) throw new Error("STOPPED");
      const completion = await mod.complete({
        apiKey,
        model: request.modelId,
        messages: request.messages as unknown as Array<{ role: "system" | "user"; content: string }>,
        maxTokens: 2500,
        temperature: 0.4,
        nanogptBilling: billing,
      });
      await recordSoloCall(userId, {
        provider: thread.provider,
        modelId: thread.modelId,
        threadId: thread.id,
        cost: completion.cost,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
      });
      if (await soloCancelled(userId, thread.id)) {
        const error = new Error("STOPPED");
        throw error;
      }
      return {
        text: completion.text,
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        cost: completion.cost,
        latencyMs: completion.latencyMs,
      };
    },
  });
  return { thread: result.thread, error: result.error, calls: result.calls };
}
