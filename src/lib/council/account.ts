import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import type { AgentResponse, AccountSettingsPublic, Artifact, ContextItem, ContextManifest, CouncilResult, Project, ProjectFile, StoreShape, Task } from "./types";
import type { ProviderId } from "./types";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export type { AccountSettingsPublic };

export const loadAccountSnapshot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<StoreShape> => {
    const mod = await import("./account.server");
    return mod.loadSnapshot(context.userId);
  });

export const loadAccountSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<AccountSettingsPublic> => {
    const mod = await import("./account.server");
    return mod.loadPublicSettings(context.userId);
  });

export const loadAccountHydrate = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ snapshot: StoreShape; settings: AccountSettingsPublic }> => {
    const mod = await import("./account.server");
    return mod.loadHydrate(context.userId);
  });

export const saveAccountSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      provider: ProviderId;
      gptModel: string;
      grokModel: string;
      claudeModel: string;
      maxCostUsd: number;
      apiKey?: string;
      clearKey?: boolean;
    }) => data,
  )
  .handler(async ({ context, data }): Promise<AccountSettingsPublic> => {
    const mod = await import("./account.server");
    return mod.saveSettings(context.userId, data);
  });

export const importAccountSnapshot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: StoreShape) => data)
  .handler(async ({ context, data }): Promise<StoreShape> => {
    const mod = await import("./account.server");
    return mod.importSnapshotIfEmpty(context.userId, data);
  });

export const persistAccountProject = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: Project) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistProject(context.userId, data);
    return { ok: true };
  });

export const persistAccountContext = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: ContextItem) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistContext(context.userId, data);
    return { ok: true };
  });

export const persistAccountTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: Task) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistTask(context.userId, data);
    return { ok: true };
  });

export const persistAccountManifest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { task: Task; manifest: ContextManifest }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistTask(context.userId, data.task);
    await mod.persistManifest(context.userId, data.manifest);
    return { ok: true };
  });

export const persistAccountCouncil = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: {
      task: Task;
      responses: AgentResponse[];
      result: CouncilResult | null;
      artifact?: Artifact | null;
      manifest?: ContextManifest | null;
      artifacts?: Artifact[];
    }) => data,
  )
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistCouncilOutput(context.userId, data);
    return { ok: true };
  });

export const persistAccountChat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { source: ChatSource; messages: HistoryMessage[]; replaceMessages: boolean }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistChat(context.userId, data.source, data.messages, data.replaceMessages);
    return { ok: true };
  });

export const persistAccountChatPatch = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: ChatSource) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistChatPatch(context.userId, data);
    return { ok: true };
  });

export const persistAccountDeleteChat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { chatId: string; tasks: Task[] }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistDeleteChat(context.userId, data.chatId, data.tasks);
    return { ok: true };
  });

export const persistAccountFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: ProjectFile) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistFile(context.userId, data);
    return { ok: true };
  });

export const persistAccountDeleteFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { fileId: string; tasks: Task[] }) => data)
  .handler(async ({ context, data }) => {
    const mod = await import("./account.server");
    await mod.persistDeleteFile(context.userId, data.fileId, data.tasks);
    return { ok: true };
  });
