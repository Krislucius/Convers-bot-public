import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { DuplicateImport, type DuplicateChoice } from "@/components/duplicate-import";
import { OpLogPanel } from "@/components/op-log";
import { ProviderField } from "@/components/provider-field";
import { Field, Panel, PrimaryButton, TextInput } from "@/components/council-ui";
import { addChatSource, replaceChatSource, useStore } from "@/lib/council/store";
import { buildChatSource, resolveImportProvider } from "@/lib/history/build-source";
import { HISTORY_NOT_CANONICAL, PRIVACY_NOTE, formatChars } from "@/lib/history/format";
import { hashContent } from "@/lib/history/hash";
import { findDuplicate } from "@/lib/history/provenance";
import { formatExceptionLog, formatImportOpLog } from "@/lib/op-log";
import type { ChatProvider, ChatSource, HistoryMessage } from "@/lib/history/types";

export const Route = createFileRoute("/p/$projectId/chats/upload")({ component: UploadPage });

const ALLOWED = [".txt", ".md", ".markdown", ".json", ".html", ".jsonl"];

function AddUploadPageInner() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ChatProvider | "AUTO">("AUTO");
  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState("");
  const [log, setLog] = useState("");
  const [pending, setPending] = useState<{ source: ChatSource; messages: HistoryMessage[]; duplicate?: ChatSource } | null>(null);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!ALLOWED.some((ext) => lower.endsWith(ext))) {
      setStatus("Upload .txt, .md, .json, or .html files.");
      setRaw("");
      setFileName("");
      setLog(
        formatImportOpLog({
          op: "upload",
          ok: false,
          provider: provider === "AUTO" ? "UNKNOWN" : provider,
          title: file.name,
          fileName: file.name,
          rawBytes: file.size,
          messageCount: 0,
          error: "Unsupported file type. Use .txt, .md, .json, or .html.",
        }),
      );
      return;
    }
    const text = await file.text();
    setFileName(file.name);
    setRaw(text);
    setStatus(`${file.name} · ${formatChars(text.length)} · ~${Math.ceil(text.length / 4)} tokens`);
    setLog(
      formatImportOpLog({
        op: "upload",
        ok: true,
        provider: provider === "AUTO" ? "UNKNOWN" : provider,
        title: file.name,
        fileName: file.name,
        rawBytes: text.length,
        messageCount: 0,
        error: null,
      }),
    );
  }

  function commit(source: ChatSource, messages: HistoryMessage[], duplicate: ChatSource | undefined, choice?: DuplicateChoice) {
    if (duplicate && !choice) {
      setPending({ source, messages, duplicate });
      return;
    }
    if (choice === "cancel") {
      setPending(null);
      return;
    }
    if (choice === "replace" && duplicate) {
      replaceChatSource(duplicate.id, source, messages);
      void navigate({ to: "/p/$projectId/chats/$chatId", params: { projectId, chatId: duplicate.id } });
      return;
    }
    addChatSource(source, messages);
    void navigate({ to: "/p/$projectId/chats/$chatId", params: { projectId, chatId: source.id } });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!raw.trim()) {
      setStatus("Choose a conversation file first.");
      setLog(formatExceptionLog("upload", new Error("Choose a conversation file first."), { fileName }));
      return;
    }
    try {
      const resolved = resolveImportProvider(provider, raw);
      const built = buildChatSource({
        projectId,
        provider: resolved,
        title: title || fileName.replace(/\.[^.]+$/, ""),
        sourceUrl: null,
        importMethod: "FILE",
        accessStatus: "NOT_CHECKED",
        importStatus: "IMPORTED",
        rawContent: raw,
      });
      const duplicate = findDuplicate(store.chatSources, projectId, hashContent(raw));
      setLog(
        formatImportOpLog({
          op: "upload",
          ok: true,
          provider: built.source.provider,
          title: built.source.title,
          fileName,
          rawBytes: raw.length,
          messageCount: built.messages.length,
          duplicate: Boolean(duplicate),
        }),
      );
      if (duplicate) {
        setStatus("This content appears to already exist in this project.");
        commit(built.source, built.messages, duplicate);
        return;
      }
      commit(built.source, built.messages, undefined);
    } catch (error) {
      const text = error instanceof Error ? error.message : "Upload failed.";
      setStatus(text);
      setLog(formatExceptionLog("upload", error, { fileName, rawBytes: raw.length }));
    }
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-2 text-lg">Upload Conversation</h2>
        <p className="text-muted">{PRIVACY_NOTE}</p>
        <p className="text-sm text-faint">{HISTORY_NOT_CANONICAL} Original file text is stored as-is.</p>
        <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
          <Field label="File" hint=".txt, .md, .json, .html">
            <input
              type="file"
              accept=".txt,.md,.markdown,.json,.html,.jsonl,text/plain,text/markdown,application/json,text/html"
              className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 py-2 text-fg"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </Field>
          {raw ? (
            <p className="m-0 text-sm tabular-nums text-muted">
              {fileName} · {formatChars(raw.length)} · ~{Math.ceil(raw.length / 4)} tokens
            </p>
          ) : null}
          <ProviderField value={provider} onChange={setProvider} />
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="submit" disabled={!raw.trim()}>
              Import
            </PrimaryButton>
            <Link
              to="/p/$projectId/chats"
              params={{ projectId }}
              className="inline-flex min-h-11 items-center rounded-sm border border-line px-3.5 font-semibold text-fg no-underline"
            >
              Back
            </Link>
          </div>
        </form>
      </Panel>
      {pending?.duplicate ? (
        <DuplicateImport existing={pending.duplicate} onChoose={(choice) => commit(pending.source, pending.messages, pending.duplicate, choice)} />
      ) : null}
      {status ? <p className="text-sm text-muted">{status}</p> : null}
      <OpLogPanel title="Upload log" value={log} empty="Choose a file or click Import to capture a detailed log." />
    </>
  );
}

function UploadPage() {
  return <AddUploadPageInner />;
}
