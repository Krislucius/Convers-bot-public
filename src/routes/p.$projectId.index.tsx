import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { SourcePicker } from "@/components/source-picker";
import { FilePicker } from "@/components/file-picker";
import { QualitySummary } from "@/components/quality-summary";
import { DangerButton, Field, GhostButton, Panel, PrimaryButton, TextArea, TextInput } from "@/components/council-ui";
import { evaluateProject } from "@/lib/council/evaluate";
import { createTask, deleteTask, useStore } from "@/lib/council/store";
import { useSession } from "@/lib/council/session";
import { TASK_MODES, defaultRequiresHistorical } from "@/lib/council/task-mode";
import type { Task, TaskMode, TaskQualityRow } from "@/lib/council/types";
import { memoryChatIds } from "@/lib/history/provenance";
import { prepareTaskInput } from "@/lib/i18n/api";
import { useI18n } from "@/lib/i18n/provider";

export const Route = createFileRoute("/p/$projectId/")({ component: TasksPage });

function TasksPage() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const { config } = useSession();
  const { t, error } = useI18n();
  const navigate = useNavigate();
  const tasks = store.tasks.filter((row) => row.projectId === projectId);
  const artifacts = store.artifacts.filter((row) => row.projectId === projectId);
  const memoryIds = useMemo(() => memoryChatIds(store.chatSources, projectId), [store.chatSources, projectId]);
  const memoryFileIds = useMemo(
    () => store.projectFiles.filter((row) => row.projectId === projectId && row.includeInMemory).map((row) => row.id),
    [store.projectFiles, projectId],
  );
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<TaskMode | "">("");
  const [requiresHistory, setRequiresHistory] = useState(true);
  const [candidateId, setCandidateId] = useState("");
  const [selected, setSelected] = useState<string[] | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const chosen = selected ?? memoryIds;
  const chosenFiles = selectedFiles ?? memoryFileIds;
  const resolvedMode = mode || null;
  const quality = evaluateProject({
    projectId,
    tasks,
    results: store.results,
    packets: store.packets,
    artifacts,
  });

  function onMode(next: TaskMode) {
    setMode(next);
    setRequiresHistory(defaultRequiresHistorical(next));
  }

  async function onTask(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !prompt.trim() || !resolvedMode || busy) return;
    setBusy(true);
    setFormError("");
    try {
      const prepared = await prepareTaskInput({ data: { title: title.trim(), prompt: prompt.trim() } });
      const task = createTask({
        projectId,
        title: prepared.title,
        prompt: prepared.canonicalTaskEn,
        originalTask: prepared.originalTask,
        canonicalTaskEn: prepared.canonicalTaskEn,
        sourceLanguage: prepared.sourceLanguage,
        originalTitle: prepared.originalTitle,
        mode: resolvedMode,
        selectedChatSourceIds: chosen,
        selectedFileIds: chosenFiles,
        requiresHistoricalContext: requiresHistory,
        candidateArtifactId: resolvedMode === "REVIEW" ? candidateId || null : null,
        decisionQuestion: resolvedMode === "DECIDE" ? prepared.canonicalTaskEn : null,
        provider: config.provider,
        selectedModels: config.members,
      });
      void navigate({ to: "/t/$taskId", params: { taskId: task.id } });
    } catch (err) {
      setFormError(error(err instanceof Error ? err.message : t("task.translateFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {tasks.length ? <QualitySummary summary={quality} /> : null}
      <Panel>
        <h2 className="font-display mb-3 text-lg">{t("task.list")}</h2>
        {tasks.length === 0 ? (
          <p className="text-muted">{t("task.empty")}</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {tasks.map((task) => {
              const qualityRow = quality.rows.find((row) => row.taskId === task.id);
              return <TaskRow key={task.id} task={task} qualityRow={qualityRow} />;
            })}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="font-display mb-3 text-lg">{t("task.new")}</h2>
        <form className="grid gap-3" onSubmit={onTask}>
          <Field label={t("task.mode")}>
            <div className="flex flex-wrap gap-2">
              {TASK_MODES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`min-h-11 rounded-sm px-3.5 font-semibold ${
                    mode === value
                      ? "border border-accent bg-accent text-accent-fg"
                      : "border border-line bg-transparent text-fg"
                  }`}
                  onClick={() => onMode(value)}
                >
                  {t(`mode.${value}.label`)}
                </button>
              ))}
            </div>
            {resolvedMode ? <p className="m-0 mt-2 text-sm text-muted">{t(`mode.${resolvedMode}.hint`)}</p> : (
              <p className="m-0 mt-2 text-sm text-warn">{t("mode.select")}</p>
            )}
          </Field>
          <Field label={t("task.title")}>
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label={resolvedMode === "DECIDE" ? t("task.decisionQuestion") : t("task.body")}>
            <TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </Field>
          {resolvedMode === "CREATE" ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line bg-subtle px-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={requiresHistory}
                onChange={(e) => setRequiresHistory(e.target.checked)}
              />
              {t("task.requiresHistory")}
            </label>
          ) : null}
          {resolvedMode === "REVIEW" ? (
            <Field label={t("task.candidate")}>
              {artifacts.length === 0 ? (
                <p className="m-0 text-sm text-warn">{t("task.noArtifacts")}</p>
              ) : (
                <select
                  className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg"
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  required
                >
                  <option value="">{t("task.selectCandidate")}</option>
                  {artifacts.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.title} v{row.version} ({row.status})
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <SourcePicker
            projectId={projectId}
            chats={store.chatSources}
            messages={store.historyMessages}
            selected={chosen}
            onChange={setSelected}
          />
          <FilePicker
            projectId={projectId}
            files={store.projectFiles}
            selected={chosenFiles}
            onChange={setSelectedFiles}
          />
          {formError ? <p className="m-0 text-sm text-danger">{formError}</p> : null}
          <PrimaryButton type="submit" disabled={!resolvedMode || busy}>
            {busy ? t("task.creating") : t("task.submit")}
          </PrimaryButton>
        </form>
      </Panel>
    </>
  );
}

function TaskRow({ task, qualityRow }: { task: Task; qualityRow?: TaskQualityRow }) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="rounded-md border border-line bg-subtle">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <Link
          to="/t/$taskId"
          params={{ taskId: task.id }}
          className="grid min-w-0 flex-1 gap-1 no-underline hover:opacity-90"
        >
          <strong className="break-words text-fg">{task.originalTitle || task.title}</strong>
          <span className="text-muted">
            {task.mode} · {t("task.run")} {qualityRow?.runStatus ?? task.status}
            {" · "}
            {t("task.verdict")} {qualityRow?.taskVerdict ?? t("status.none")}
          </span>
          <span className="text-xs text-faint">
            {task.selectedChatSourceIds.length === 1
              ? t("task.chatsSelected", { count: task.selectedChatSourceIds.length })
              : t("task.chatsSelectedPlural", { count: task.selectedChatSourceIds.length })}
            {" · "}
            {task.selectedFileIds.length === 1
              ? t("task.filesSelected", { count: task.selectedFileIds.length })
              : t("task.filesSelectedPlural", { count: task.selectedFileIds.length })}
          </span>
        </Link>
        {confirm ? (
          <div className="grid min-w-0 gap-2 sm:max-w-60">
            <p className="m-0 text-sm text-danger">{t("task.deleteConfirm")}</p>
            <div className="flex flex-wrap gap-2">
              <DangerButton type="button" onClick={() => deleteTask(task.id)}>
                <Trash2 className="size-4" aria-hidden="true" />
                {t("task.deleteYes")}
              </DangerButton>
              <GhostButton type="button" onClick={() => setConfirm(false)}>
                {t("task.deleteCancel")}
              </GhostButton>
            </div>
          </div>
        ) : (
          <DangerButton
            type="button"
            className="w-full shrink-0 sm:w-auto"
            onClick={() => setConfirm(true)}
            aria-label={t("task.delete")}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            {t("task.delete")}
          </DangerButton>
        )}
      </div>
    </li>
  );
}
