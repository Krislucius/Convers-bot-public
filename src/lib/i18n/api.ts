import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { deriveDecisionRecord } from "@/lib/council/decision";
import { exclusiveRunState } from "@/lib/council/terminal";
import { indexSelectedRepositories } from "@/lib/evidence/repo-index";
import { normalizeUiLanguage, type UiLanguage } from "./locale.ts";
import { prepareTaskText, type PreparedTaskText } from "./task-text.ts";
import {
  localizeCouncilNarrative,
  localizeDecisionRecord,
  localizeDecisionRecordStatic,
  type LocalizedDecisionView,
  type LocalizedNarrative,
} from "./result-localize.ts";

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
  .handler(
    async ({
      context,
      data,
    }): Promise<{
      view: LocalizedDecisionView | null;
      narrative: LocalizedNarrative | null;
      language: UiLanguage;
      error?: string | null;
    }> => {
      const language = normalizeUiLanguage(data.language);
      const { translateWithXai } = await import("./translate");
      const mod = await import("@/lib/council/account.server");
      const snapshot = await mod.loadSnapshot(context.userId);
      const task = snapshot.tasks.find((row) => row.id === data.taskId) ?? null;
      const result = snapshot.results.find((row) => row.taskId === data.taskId) ?? null;
      const responses = snapshot.responses.filter((row) => row.taskId === data.taskId);
      if (!task) return { view: null, narrative: null, language, error: null };
      const terminal = exclusiveRunState({
        status: task.status,
        taskStatus: task.status,
        result,
      });
      const record = deriveDecisionRecord({
        mode: task.mode,
        runStatus: terminal === "COMPLETE" || terminal === "FAILED" || terminal === "CANCELLED" ? terminal : null,
        result,
        implementation: indexSelectedRepositories({
          files: snapshot.projectFiles.filter(
            (file) => file.projectId === task.projectId && (task.selectedFileIds ?? []).includes(file.id),
          ),
          designMentions: [
            task.canonicalTaskEn || task.prompt,
            snapshot.artifacts.find((row) => row.taskId === task.id || row.id === task.candidateArtifactId)?.content ?? "",
            ...snapshot.context
              .filter((row) => row.projectId === task.projectId && row.kind !== "RAW_HISTORY")
              .map((row) => row.content),
          ],
        }),
      });
      const cached = result ? await mod.loadResultLocalization(context.userId, data.taskId) : null;
      let out: Awaited<ReturnType<typeof localizeDecisionRecord>>;
      let narrativeOut: Awaited<ReturnType<typeof localizeCouncilNarrative>>;
      try {
        out = await localizeDecisionRecord(record, language, cached, translateWithXai);
        narrativeOut = await localizeCouncilNarrative(
          result,
          responses,
          language,
          cached?.narrative ?? null,
          translateWithXai,
        );
      } catch {
        return {
          view: language === "ru" ? localizeDecisionRecordStatic(record, "ru") : null,
          narrative: null,
          language,
          error: "TRANSLATION_FAILED",
        };
      }
      if (language === "ru" && out.cache) {
        await mod.saveResultLocalization(context.userId, data.taskId, {
          ...out.cache,
          narrative: narrativeOut.cache ?? out.cache.narrative,
        });
      }
      return {
        view: out.view,
        narrative: narrativeOut.view,
        language,
        error: out.failed ? "TRANSLATION_FAILED" : null,
      };
    },
  );
