import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePicker } from "@/components/file-picker";
import { SourcePicker } from "@/components/source-picker";
import { GhostButton, PrimaryButton, Select, TextArea } from "@/components/council-ui";
import { buildChatSource } from "@/lib/history/build-source";
import { addChatSource, useStore } from "@/lib/council/store";
import { PROVIDER_IDS, isProviderId, providerName, slotFor } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import type { ProviderId } from "@/lib/council/types";
import { useI18n } from "@/lib/i18n/provider";
import {
  cancelSoloFn,
  createSoloThreadFn,
  listSoloThreadsFn,
  sendSoloFn,
  stopSoloPartialFn,
  transitionSoloFn,
  updateSoloThreadFn,
  usageCountsFn,
} from "@/lib/solo/api";
import {
  buildContextPack,
  handoffSnapshot,
  planModelChange,
  renderSoloJson,
  renderSoloMarkdown,
  type SoloThread,
} from "@/lib/solo/logic";

export const Route = createFileRoute("/p/$projectId/solo")({
  validateSearch: (search: Record<string, unknown>) => ({
    thread: typeof search.thread === "string" ? search.thread : undefined,
  }),
  component: SoloPage,
});

function verifiedModels(provider: ProviderId, catalog: { provider: string; models: Array<{ id: string; name: string; access: string }> } | null) {
  if (!catalog || catalog.provider !== provider) return [];
  return catalog.models.filter((row) => row.access === "VERIFIED_AVAILABLE");
}

function downloadText(name: string, body: string, type: string) {
  const blob = new Blob([body], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function SoloPage() {
  const { projectId } = Route.useParams();
  const { thread: threadId } = Route.useSearch();
  const navigate = useNavigate();
  const store = useStore();
  const { config } = useSession();
  const { t } = useI18n();
  const project = store.projects.find((row) => row.id === projectId);
  const [threads, setThreads] = useState<SoloThread[]>([]);
  const [thread, setThread] = useState<SoloThread | null>(null);
  const [draftProvider, setDraftProvider] = useState<ProviderId>(config.provider);
  const [draftModel, setDraftModel] = useState("");
  const [pending, setPending] = useState<{ provider: ProviderId; modelId: string } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [reveal, setReveal] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [localContext, setLocalContext] = useState(false);
  const [localChats, setLocalChats] = useState<string[]>([]);
  const [localFiles, setLocalFiles] = useState<string[]>([]);
  const [localArtifacts, setLocalArtifacts] = useState<string[]>([]);
  const [usage, setUsage] = useState<{ soloCalls: number; councilCalls: number } | null>(null);
  const stopRef = useRef(false);
  const revealRef = useRef("");

  const activeProvider = pending?.provider ?? thread?.provider ?? draftProvider;
  const models = verifiedModels(activeProvider, config.catalog);
  const activeModel = pending?.modelId ?? thread?.modelId ?? draftModel;
  const keyReady = slotFor(config, activeProvider).saved;
  const catalogReady = Boolean(config.catalog && config.catalog.provider === activeProvider);
  const artifacts = store.artifacts.filter((row) => row.projectId === projectId);

  const pack = useMemo(() => {
    const basis: SoloThread = thread ?? {
      id: "draft",
      projectId,
      provider: draftProvider,
      modelId: draftModel,
      modelLabel: draftModel,
      title: "Solo",
      contextEnabled: localContext,
      selectedChatIds: localChats,
      selectedFileIds: localFiles,
      selectedArtifactIds: localArtifacts,
      createdAt: "",
      updatedAt: "",
      messages: [],
      transitions: [],
    };
    return buildContextPack(basis, {
      instructions: project?.description ?? "",
      chats: store.chatSources.filter((row) => row.projectId === projectId).map((row) => ({ id: row.id, title: row.title, text: row.rawContent })),
      files: store.projectFiles.filter((row) => row.projectId === projectId),
      artifacts: artifacts.map((row) => ({ id: row.id, title: row.title, content: row.content })),
    });
  }, [thread, project?.description, store.chatSources, store.projectFiles, artifacts, projectId, draftProvider, draftModel, localContext, localChats, localFiles, localArtifacts]);

  useEffect(() => {
    let cancelled = false;
    void listSoloThreadsFn({ data: { projectId } })
      .then((rows) => {
        if (cancelled) return;
        setThreads(rows);
        const current = threadId ? rows.find((row) => row.id === threadId) : rows[0];
        if (current) setThread(current);
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : "SOLO_LOAD_FAILED");
      });
    void usageCountsFn()
      .then((row) => {
        if (!cancelled) setUsage(row);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, threadId]);

  function openThread(next: SoloThread | null) {
    setThread(next);
    setPending(null);
    setReveal(null);
    setPicked([]);
    void navigate({
      to: "/p/$projectId/solo",
      params: { projectId },
      search: { thread: next ? next.id : undefined },
    });
  }

  async function persistContext(next: SoloThread) {
    const saved = await updateSoloThreadFn({
      data: {
        threadId: next.id,
        contextEnabled: next.contextEnabled,
        selectedChatIds: next.selectedChatIds,
        selectedFileIds: next.selectedFileIds,
        selectedArtifactIds: next.selectedArtifactIds,
      },
    });
    setThread(saved);
    setThreads((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
  }

  function requestModel(provider: ProviderId, modelId: string) {
    if (!thread) {
      setDraftProvider(provider);
      setDraftModel(modelId);
      return;
    }
    if (!planModelChange(thread, { provider, modelId }).needsConfirm) {
      setPending(null);
      return;
    }
    if (!slotFor(config, provider).saved || (config.catalog && config.catalog.provider !== provider)) {
      setNotice(t("solo.catalogRequired"));
      return;
    }
    if (!verifiedModels(provider, config.catalog).some((row) => row.id === modelId) && modelId !== thread.modelId) {
      setNotice(t("solo.catalogRequired"));
      return;
    }
    setPending({ provider, modelId });
    setNotice(t("solo.confirmSwitch"));
  }

  async function confirmModel() {
    if (!thread || !pending) return;
    const label = models.find((row) => row.id === pending.modelId)?.name ?? pending.modelId;
    const saved = await transitionSoloFn({
      data: { threadId: thread.id, provider: pending.provider, modelId: pending.modelId, modelLabel: label, confirm: true },
    });
    setThread(saved);
    setThreads((rows) => rows.map((row) => (row.id === saved.id ? saved : row)));
    setPending(null);
    setNotice(`${t("solo.modelChanged")}. ${t("solo.transitionSaved")}.`);
  }

  async function ensureThread(): Promise<SoloThread> {
    if (thread) return thread;
    if (!draftModel || !keyReady || !catalogReady) throw new Error(t("solo.pickModel"));
    const label = models.find((row) => row.id === draftModel)?.name ?? draftModel;
    const created = await createSoloThreadFn({
      data: { projectId, provider: draftProvider, modelId: draftModel, modelLabel: label },
    });
    const withContext =
      localContext || localChats.length || localFiles.length || localArtifacts.length
        ? await updateSoloThreadFn({
            data: {
              threadId: created.id,
              contextEnabled: localContext,
              selectedChatIds: localChats,
              selectedFileIds: localFiles,
              selectedArtifactIds: localArtifacts,
            },
          })
        : created;
    setThread(withContext);
    setThreads((rows) => [withContext, ...rows]);
    void navigate({ to: "/p/$projectId/solo", params: { projectId }, search: { thread: withContext.id } });
    return withContext;
  }

  function play(full: string) {
    revealRef.current = "";
    setReveal("");
    let index = 0;
    const step = Math.max(12, Math.ceil(full.length / 48));
    const timer = window.setInterval(() => {
      if (stopRef.current) {
        window.clearInterval(timer);
        return;
      }
      index = Math.min(full.length, index + step);
      revealRef.current = full.slice(0, index);
      setReveal(revealRef.current);
      if (index >= full.length) {
        window.clearInterval(timer);
        setReveal(null);
      }
    }, 32);
  }

  async function onSend(regenerate = false) {
    if (busy) return;
    const userText = text.trim();
    if (!regenerate && !userText) return;
    setBusy(true);
    stopRef.current = false;
    setNotice("");
    try {
      const current = await ensureThread();
      if (!regenerate) setText("");
      const result = await sendSoloFn({ data: { threadId: current.id, userText: regenerate ? undefined : userText, regenerate } });
      setThread(result.thread);
      setThreads((rows) => rows.map((row) => (row.id === result.thread.id ? result.thread : row)));
      const last = [...result.thread.messages].reverse().find((row) => row.role === "ASSISTANT");
      if (stopRef.current) {
        const partial = revealRef.current || last?.content || "";
        const stopped = await stopSoloPartialFn({ data: { threadId: result.thread.id, partial } });
        setThread(stopped);
        setReveal(null);
      } else if (last && !last.error) {
        play(last.content);
      }
      if (result.error && result.error !== "STOPPED") setNotice(result.error);
      const counts = await usageCountsFn().catch(() => null);
      if (counts) setUsage(counts);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "SOLO_FAILED");
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    stopRef.current = true;
    if (!thread) return;
    await cancelSoloFn({ data: { threadId: thread.id } }).catch(() => undefined);
    if (revealRef.current) {
      const stopped = await stopSoloPartialFn({ data: { threadId: thread.id, partial: revealRef.current } });
      setThread(stopped);
      setReveal(null);
    }
  }

  async function copyLast() {
    const last = [...(thread?.messages ?? [])].reverse().find((row) => row.role === "ASSISTANT");
    if (!last) return;
    await navigator.clipboard.writeText(last.content);
    setNotice(t("solo.copied"));
  }

  function manifest() {
    if (!thread) return [];
    const chats = store.chatSources.filter((row) => thread.selectedChatIds.includes(row.id)).map((row) => `chat ${row.id} ${row.title}`);
    const files = store.projectFiles.filter((row) => thread.selectedFileIds.includes(row.id)).map((row) => `file ${row.id} ${row.filename} ${row.sourceStatus ?? ""}`);
    return [...chats, ...files];
  }

  function handoff(scope: "ALL" | "LAST" | string[]) {
    if (!thread) return;
    const snap = handoffSnapshot(thread, scope, new Date().toISOString());
    const built = buildChatSource({
      projectId,
      provider: "UNKNOWN",
      title: `SOLO ${thread.provider} ${thread.modelId}`,
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: snap.text,
      includeInMemory: true,
    });
    addChatSource(built.source, built.messages);
    void navigate({ to: "/p/$projectId", params: { projectId } });
  }

  const shown = thread?.messages ?? [];
  const modelOptions = models.some((row) => row.id === activeModel) || !activeModel ? models : [{ id: activeModel, name: thread?.modelLabel || activeModel, access: "VERIFIED_AVAILABLE" }, ...models];

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display m-0 text-2xl">{t("solo.title")}</h2>
          <p className="m-0 mt-1 text-sm text-muted">
            {providerName(activeProvider)} · {thread?.modelLabel || activeModel || "—"}
            {usage ? ` · ${t("solo.calls", { solo: usage.soloCalls, council: usage.councilCalls })}` : ""}
          </p>
        </div>
        <GhostButton type="button" onClick={() => openThread(null)}>
          {t("solo.newThread")}
        </GhostButton>
      </header>

      {threads.length ? (
        <div className="flex gap-2 overflow-x-auto" aria-label={t("solo.threads")}>
          {threads.map((row) => (
            <GhostButton key={row.id} type="button" onClick={() => openThread(row)}>
              {row.title || row.modelLabel}
            </GhostButton>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm text-muted">
          {t("solo.provider")}
          <Select
            value={activeProvider}
            onChange={(event) => {
              const provider = event.target.value;
              if (!isProviderId(provider)) return;
              const nextModels = verifiedModels(provider, config.catalog);
              const modelId = provider === thread?.provider ? thread.modelId : (nextModels[0]?.id ?? "");
              if (!modelId) {
                setNotice(t("solo.catalogRequired"));
                return;
              }
              requestModel(provider, modelId);
            }}
          >
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {providerName(id)}
              </option>
            ))}
          </Select>
        </label>
        <label className="grid gap-1 text-sm text-muted">
          {t("solo.model")}
          <Select
            value={activeModel}
            onChange={(event) => requestModel(activeProvider, event.target.value)}
          >
            <option value="">{t("solo.pickModel")}</option>
            {modelOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name || row.id}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {!keyReady ? <p className="m-0 text-sm text-danger">{t("solo.noKey")}</p> : null}
      {keyReady && !catalogReady && !thread ? <p className="m-0 text-sm text-muted">{t("solo.catalogRequired")}</p> : null}
      {pending ? (
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted">
          {t("solo.confirmSwitch")}
          <PrimaryButton type="button" onClick={() => void confirmModel()}>
            {t("solo.confirm")}
          </PrimaryButton>
          <GhostButton type="button" onClick={() => setPending(null)}>
            {t("solo.cancel")}
          </GhostButton>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <GhostButton
          type="button"
          onClick={() => {
            if (!thread) {
              setLocalContext((on) => !on);
              return;
            }
            void persistContext({ ...thread, contextEnabled: !thread.contextEnabled });
          }}
        >
          {(thread ? thread.contextEnabled : localContext) ? t("solo.contextOn") : t("solo.contextOff")}
        </GhostButton>
        <span>{t("solo.sources", { count: pack.chats })}</span>
        <span>{t("solo.files", { count: pack.files })}</span>
        <span>{t("solo.tokens", { count: pack.tokens })}</span>
      </div>

      <div className="grid gap-3">
          <SourcePicker
            projectId={projectId}
            chats={store.chatSources}
            messages={store.historyMessages}
            selected={thread ? thread.selectedChatIds : localChats}
            onChange={(ids) => {
              if (!thread) {
                setLocalChats(ids);
                return;
              }
              void persistContext({ ...thread, selectedChatIds: ids });
            }}
          />
          <FilePicker
            projectId={projectId}
            files={store.projectFiles}
            selected={thread ? thread.selectedFileIds : localFiles}
            onChange={(ids) => {
              if (!thread) {
                setLocalFiles(ids);
                return;
              }
              void persistContext({ ...thread, selectedFileIds: ids });
            }}
          />
          {artifacts.length ? (
            <fieldset className="m-0 grid gap-2 border-0 p-0">
              <legend className="text-sm text-muted">{t("task.candidate")}</legend>
              {artifacts.map((row) => {
                const selected = thread ? thread.selectedArtifactIds : localArtifacts;
                return (
                  <label key={row.id} className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={() => {
                        const ids = selected.includes(row.id) ? selected.filter((id) => id !== row.id) : [...selected, row.id];
                        if (!thread) {
                          setLocalArtifacts(ids);
                          return;
                        }
                        void persistContext({ ...thread, selectedArtifactIds: ids });
                      }}
                    />
                    {row.title}
                  </label>
                );
              })}
            </fieldset>
          ) : null}
        </div>

      <div className="grid gap-3">
        {shown.length === 0 ? <p className="m-0 text-sm text-muted">{t("solo.empty")}</p> : null}
        {shown.map((row) => {
          if (row.role === "TRANSITION") {
            return (
              <p key={row.id} className="m-0 text-xs text-faint">
                {t("solo.transition")} · {row.content}
              </p>
            );
          }
          const body = row.role === "ASSISTANT" && reveal !== null && row.id === shown.filter((item) => item.role === "ASSISTANT").at(-1)?.id ? reveal : row.content;
          return (
            <article key={row.id} className="rounded-md border border-line bg-elevated p-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-faint">
                <span>{row.role === "USER" ? "USER" : row.role === "ASSISTANT" ? thread?.modelLabel : row.role}</span>
                {row.role === "USER" || row.role === "ASSISTANT" ? (
                  <label className="inline-flex min-h-11 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={picked.includes(row.id)}
                      onChange={() => setPicked((ids) => (ids.includes(row.id) ? ids.filter((id) => id !== row.id) : [...ids, row.id]))}
                    />
                    {row.createdAt}
                  </label>
                ) : (
                  <span>{row.createdAt}</span>
                )}
              </div>
              <p className="m-0 whitespace-pre-wrap text-sm">{body || "—"}</p>
              {row.citations.length ? <p className="m-0 mt-2 text-xs text-muted">{row.citations.join(" ")}</p> : null}
              {row.stopped ? <p className="m-0 mt-2 text-xs text-muted">{t("solo.stop")}</p> : null}
            </article>
          );
        })}
      </div>

      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void onSend(false);
        }}
      >
        <TextArea value={text} onChange={(event) => setText(event.target.value)} placeholder={t("solo.empty")} />
        <div className="flex flex-wrap gap-2">
          {busy ? (
            <GhostButton type="button" onClick={() => void onStop()}>
              {t("solo.stop")}
            </GhostButton>
          ) : (
            <PrimaryButton type="submit" disabled={!keyReady || (!thread && (!draftModel || !catalogReady))}>
              {t("solo.send")}
            </PrimaryButton>
          )}
          <GhostButton type="button" disabled={!thread || busy} onClick={() => void onSend(true)}>
            {t("solo.regenerate")}
          </GhostButton>
          <GhostButton type="button" disabled={!thread} onClick={() => void copyLast()}>
            {t("solo.copy")}
          </GhostButton>
          <GhostButton
            type="button"
            disabled={!thread}
            onClick={() => thread && downloadText(`solo-${thread.id}.md`, renderSoloMarkdown(thread, manifest()), "text/markdown")}
          >
            {t("solo.download")}
          </GhostButton>
          <GhostButton
            type="button"
            disabled={!thread}
            onClick={() => thread && downloadText(`solo-${thread.id}.json`, renderSoloJson(thread), "application/json")}
          >
            {t("solo.downloadJson")}
          </GhostButton>
        </div>
      </form>

      {thread ? (
        <div className="grid gap-2">
          <p className="m-0 text-sm text-muted">{t("solo.handoffNote")}</p>
          <div className="flex flex-wrap gap-2">
            <GhostButton type="button" onClick={() => handoff("ALL")}>
              {t("solo.handoffAll")}
            </GhostButton>
            <GhostButton type="button" disabled={picked.length === 0} onClick={() => handoff(picked)}>
              {t("solo.handoffSelected")}
            </GhostButton>
            <GhostButton type="button" onClick={() => handoff("LAST")}>
              {t("solo.handoffLast")}
            </GhostButton>
            <span className="self-center text-sm font-semibold">{t("solo.toCouncil")}</span>
          </div>
        </div>
      ) : null}
      {notice ? <p className="m-0 text-sm text-muted">{notice}</p> : null}
    </section>
  );
}
