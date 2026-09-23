import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { isProviderId } from "@/lib/council/providers";
import type { ProviderId } from "@/lib/council/types";
import { applyModelChange, createSoloThread, seedFromCouncil, type SoloThread } from "./logic";

function nid(): string {
  return `solo_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export const listSoloThreadsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { projectId: string }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./store.server");
    return mod.listSoloThreads(context.userId, data.projectId);
  });

export const usageCountsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const mod = await import("./store.server");
    return mod.usageCounts(context.userId);
  });

export const createSoloThreadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      projectId: string;
      provider: ProviderId;
      modelId: string;
      modelLabel?: string;
      seed?: { decision: string; artifact?: string | null; evidenceRefs?: string[] };
    }) => data,
  )
  .handler(async ({ context, data }): Promise<SoloThread> => {
    if (!isProviderId(data.provider) || !data.modelId.trim()) throw new Error("MODEL_REQUIRED");
    const now = new Date().toISOString();
    const thread = data.seed
      ? seedFromCouncil({
          id: nid(),
          projectId: data.projectId,
          provider: data.provider,
          modelId: data.modelId.trim(),
          modelLabel: data.modelLabel,
          now,
          decision: data.seed.decision,
          artifact: data.seed.artifact,
          evidenceRefs: data.seed.evidenceRefs,
        })
      : createSoloThread({
          id: nid(),
          projectId: data.projectId,
          provider: data.provider,
          modelId: data.modelId.trim(),
          modelLabel: data.modelLabel,
          now,
        });
    const mod = await import("./store.server");
    await mod.saveSoloThread(context.userId, thread);
    return thread;
  });

export const updateSoloThreadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      threadId: string;
      contextEnabled: boolean;
      selectedChatIds: string[];
      selectedFileIds: string[];
      selectedArtifactIds: string[];
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const mod = await import("./store.server");
    const current = await mod.loadSoloThread(context.userId, data.threadId);
    if (!current) throw new Error("THREAD_NOT_FOUND");
    const next: SoloThread = {
      ...current,
      contextEnabled: data.contextEnabled,
      selectedChatIds: data.selectedChatIds,
      selectedFileIds: data.selectedFileIds,
      selectedArtifactIds: data.selectedArtifactIds,
      updatedAt: new Date().toISOString(),
    };
    await mod.saveSoloThread(context.userId, next);
    return next;
  });

export const transitionSoloFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { threadId: string; provider: ProviderId; modelId: string; modelLabel?: string; confirm: boolean }) => data)
  .handler(async ({ context, data }) => {
    if (!data.confirm) throw new Error("TRANSITION_NOT_CONFIRMED");
    if (!isProviderId(data.provider) || !data.modelId.trim()) throw new Error("MODEL_REQUIRED");
    const mod = await import("./store.server");
    const current = await mod.loadSoloThread(context.userId, data.threadId);
    if (!current) throw new Error("THREAD_NOT_FOUND");
    const next = applyModelChange(current, { provider: data.provider, modelId: data.modelId.trim(), modelLabel: data.modelLabel }, new Date().toISOString(), true);
    await mod.saveSoloThread(context.userId, next);
    return next;
  });

export const sendSoloFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { threadId: string; userText?: string; regenerate?: boolean }) => data)
  .handler(async ({ context, data }) => {
    const store = await import("./store.server");
    const current = await store.loadSoloThread(context.userId, data.threadId);
    if (!current) throw new Error("THREAD_NOT_FOUND");
    await store.setSoloCancel(context.userId, data.threadId, false);
    const turn = await import("./turn.server");
    const result = await turn.runSoloTurn(context.userId, current, { userText: data.userText, regenerate: data.regenerate });
    await store.saveSoloThread(context.userId, result.thread);
    return result;
  });

export const cancelSoloFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { threadId: string }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./store.server");
    await mod.setSoloCancel(context.userId, data.threadId, true);
    return { ok: true };
  });

export const stopSoloPartialFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { threadId: string; partial: string }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./store.server");
    const { stopLastAssistant } = await import("./logic");
    const current = await mod.loadSoloThread(context.userId, data.threadId);
    if (!current) throw new Error("THREAD_NOT_FOUND");
    const next = stopLastAssistant(current, data.partial);
    await mod.saveSoloThread(context.userId, next);
    return next;
  });
