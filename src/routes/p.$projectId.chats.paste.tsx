import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { DuplicateImport, type DuplicateChoice } from "@/components/duplicate-import";
import { OpLogPanel } from "@/components/op-log";
import { ProviderField } from "@/components/provider-field";
import { Field, Panel, PrimaryButton, TextArea, TextInput } from "@/components/council-ui";
import { addChatSource, replaceChatSource, useStore } from "@/lib/council/store";
import { buildChatSource, resolveImportProvider } from "@/lib/history/build-source";
import { HISTORY_NOT_CANONICAL, PRIVACY_NOTE, formatChars } from "@/lib/history/format";
import { hashContent } from "@/lib/history/hash";
import { findDuplicate } from "@/lib/history/provenance";
import { formatExceptionLog, formatImportOpLog } from "@/lib/op-log";
import type { ChatProvider, ChatSource, HistoryMessage } from "@/lib/history/types";

export const Route = createFileRoute("/p/$projectId/chats/paste")({ component: PastePage });

function PastePage() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const navigate = useNavigate();
  const [provider, setProvider] = useState<ChatProvider | "AUTO">("AUTO");
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [status, setStatus] = useState("");
  const [log, setLog] = useState("");
  const [pending, setPending] = useState<{ source: ChatSource; messages: HistoryMessage[]; duplicate?: ChatSource } | null>(null);

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
      setLog(formatExceptionLog("paste", new Error("Paste a conversation first.")));
      return;
    }
    try {
      const resolved = resolveImportProvider(provider, raw);
      const built = buildChatSource({
        projectId,
        provider: resolved,
        title,
        sourceUrl: null,
        importMethod: "PASTE",
        accessStatus: "NOT_CHECKED",
        importStatus: "IMPORTED",
        rawContent: raw,
      });
      const duplicate = findDuplicate(store.chatSources, projectId, hashContent(raw));
      setLog(
        formatImportOpLog({
          op: "paste",
          ok: true,
          provider: built.source.provider,
          title: built.source.title,
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
      const text = error instanceof Error ? error.message : "Paste import failed.";
      setStatus(text);
      setLog(formatExceptionLog("paste", error, { rawBytes: raw.length }));
    }
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-2 text-lg">Paste Conversation</h2>
        <p className="text-muted">{PRIVACY_NOTE}</p>
        <p className="text-sm text-faint">{HISTORY_NOT_CANONICAL} The original paste is stored unchanged.</p>
        <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
          <ProviderField value={provider} onChange={setProvider} />
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label="Conversation"
            hint={`${formatChars(raw.length)} · ~${raw.length ? Math.ceil(raw.length / 4) : 0} tokens`}
          >
            <TextArea
              className="min-h-paste font-mono text-sm"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="Paste the full conversation here."
              required
            />
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
      <OpLogPanel title="Paste log" value={log} empty="Import a pasted conversation to capture a detailed log." />
    </>
  );
}
