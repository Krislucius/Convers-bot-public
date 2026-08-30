import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useMemo, useState } from "react";
import { SourcePicker } from "@/components/source-picker";
import { FilePicker } from "@/components/file-picker";
import { Field, Panel, PrimaryButton, TextArea, TextInput } from "@/components/council-ui";
import { createTask, useStore } from "@/lib/council/store";
import { MODE_COPY, TASK_MODES, defaultRequiresHistorical } from "@/lib/council/task-mode";
import type { TaskMode } from "@/lib/council/types";
import { memoryChatIds } from "@/lib/history/provenance";

export const Route = createFileRoute("/p/$projectId/")({ component: TasksPage });

function TasksPage() {
  const { projectId } = Route.useParams();
  const store = useStore();
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
  const chosen = selected ?? memoryIds;
  const chosenFiles = selectedFiles ?? memoryFileIds;
  const resolvedMode = mode || null;

  function onMode(next: TaskMode) {
    setMode(next);
    setRequiresHistory(defaultRequiresHistorical(next));
  }

  function onTask(e: FormEvent) {
    e.preventDefault();
    if (!title.trim() || !prompt.trim() || !resolvedMode) return;
    const task = createTask({
      projectId,
      title: title.trim(),
      prompt: prompt.trim(),
      mode: resolvedMode,
      selectedChatSourceIds: chosen,
      selectedFileIds: chosenFiles,
      requiresHistoricalContext: requiresHistory,
      candidateArtifactId: resolvedMode === "REVIEW" ? candidateId || null : null,
      decisionQuestion: resolvedMode === "DECIDE" ? prompt.trim() : null,
    });
    void navigate({ to: "/t/$taskId", params: { taskId: task.id } });
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-3 text-lg">Tasks</h2>
        {tasks.length === 0 ? (
          <p className="text-muted">No tasks.</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {tasks.map((task) => (
              <li key={task.id}>
                <Link
                  to="/t/$taskId"
                  params={{ taskId: task.id }}
                  className="grid gap-1 rounded-md border border-line bg-subtle p-4 no-underline hover:border-line-strong"
                >
                  <strong className="break-words">{task.title}</strong>
                  <span className="text-muted">
                    {task.mode} · {task.status.replaceAll("_", " ")}
                  </span>
                  <span className="text-xs text-faint">
                    {task.selectedChatSourceIds.length} AI chat
                    {task.selectedChatSourceIds.length === 1 ? "" : "s"}
                    {" · "}
                    {task.selectedFileIds.length} file
                    {task.selectedFileIds.length === 1 ? "" : "s"} selected for Council
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <h2 className="font-display mb-3 text-lg">New task</h2>
        <form className="grid gap-3" onSubmit={onTask}>
          <Field label="Task mode">
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
                  {MODE_COPY[value].label}
                </button>
              ))}
            </div>
            {resolvedMode ? <p className="m-0 mt-2 text-sm text-muted">{MODE_COPY[resolvedMode].hint}</p> : (
              <p className="m-0 mt-2 text-sm text-warn">Select CREATE, REVIEW, or DECIDE.</p>
            )}
          </Field>
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label={resolvedMode === "DECIDE" ? "Decision question" : "Task"}>
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
              Requires historical context
            </label>
          ) : null}
          {resolvedMode === "REVIEW" ? (
            <Field label="Candidate artifact">
              {artifacts.length === 0 ? (
                <p className="m-0 text-sm text-warn">No artifacts yet. Run a CREATE task first.</p>
              ) : (
                <select
                  className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg"
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  required
                >
                  <option value="">Select a candidate</option>
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
          <PrimaryButton type="submit" disabled={!resolvedMode}>
            Create task
          </PrimaryButton>
        </form>
      </Panel>
    </>
  );
}
