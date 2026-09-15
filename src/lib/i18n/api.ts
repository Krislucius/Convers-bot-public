import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { deriveDecisionRecord } from "@/lib/council/decision";
import { exclusiveRunState } from "@/lib/council/terminal";
import { normalizeUiLanguage, type UiLanguage } from "./locale.ts";
import { prepareTaskText, type PreparedTaskText } from "./task-text.ts";
import { localizeDecisionRecord, type LocalizedDecisionView } from "./result-localize.ts";

export const prepareTaskInput = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { title: string; prompt: string }) => data)
  .handler(async ({ data }): Promise<PreparedTaskText> => {
    const { translateWithXai } = await import("./translate");
    return prepareTaskText(data, translateWithXai);
  });

export const saveUiLanguage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { language: UiLanguage }) => data)
  .handler(async ({ context, data }): Promise<{ language: UiLanguage }> => {
    const language = normalizeUiLanguage(data.language);
    const mod = await import("@/lib/council/account.server");
    await mod.saveUiLanguage(context.userId, language);
    return { language };
  });

export const localizeTaskResult = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { taskId: string; language: UiLanguage }) => data)
  .handler(async ({ context, data }): Promise<{ view: LocalizedDecisionView | null; language: UiLanguage }> => {
    const language = normalizeUiLanguage(data.language);
    const { translateWithXai } = await import("./translate");
    const mod = await import("@/lib/council/account.server");
    const snapshot = await mod.loadSnapshot(context.userId);
    const task = snapshot.tasks.find((row) => row.id === data.taskId) ?? null;
    const result = snapshot.results.find((row) => row.taskId === data.taskId) ?? null;
    if (!task) return { view: null, language };
    const terminal = exclusiveRunState({
      status: task.status,
      taskStatus: task.status,
      result,
    });
    const record = deriveDecisionRecord({
      mode: task.mode,
      runStatus: terminal === "COMPLETE" || terminal === "FAILED" || terminal === "CANCELLED" ? terminal : null,
      result,
    });
    const cached = result ? await mod.loadResultLocalization(context.userId, data.taskId) : null;
    const out = await localizeDecisionRecord(record, language, cached, translateWithXai);
    if (language === "ru" && out.translated && out.cache) {
      await mod.saveResultLocalization(context.userId, data.taskId, out.cache);
    }
    return { view: out.view, language };
  });
