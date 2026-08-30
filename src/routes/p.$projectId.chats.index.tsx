import { createFileRoute, Link } from "@tanstack/react-router";
import { ClipboardPaste, Link2, Search, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { ChatSourceCard } from "@/components/chat-source-card";
import { OpLogPanel } from "@/components/op-log";
import { Field, Panel, Select, TextInput } from "@/components/council-ui";
import { recordAccessCheck, replaceChatSource, useStore } from "@/lib/council/store";
import { buildChatSource } from "@/lib/history/build-source";
import { PROVIDER_LABEL, PROVIDERS, PRIVACY_NOTE, HISTORY_NOT_CANONICAL, formatChars } from "@/lib/history/format";
import { checkChatUrl, importChatUrl } from "@/lib/history/run-history";
import { accessCheckException } from "@/lib/history/access";
import { searchChatSources } from "@/lib/history/search";
import { memoryChatCount } from "@/lib/history/provenance";
import { formatAccessOpLog, formatExceptionLog, formatImportOpLog } from "@/lib/op-log";
import type { ChatProvider } from "@/lib/history/types";

export const Route = createFileRoute("/p/$projectId/chats/")({ component: ChatsPage });

function ChatsPage() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const [q, setQ] = useState("");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState<ChatProvider | "ALL">("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flash, setFlash] = useState("");
  const [log, setLog] = useState("");

  const rows = useMemo(
    () =>
      searchChatSources(store.chatSources, store.historyMessages, projectId, {
        q,
        title,
        provider,
        includeArchived: showArchived,
      }),
    [store.chatSources, store.historyMessages, projectId, q, title, provider, showArchived],
  );

  const bytes = store.chatSources
    .filter((row) => row.projectId === projectId)
    .reduce((sum, row) => sum + row.characterCount, 0);
  const memory = memoryChatCount(store.chatSources, projectId);

  async function recheck(id: string, url: string | null, sourceProvider: ChatProvider) {
    if (!url) return;
    setBusyId(id);
    setFlash("Checking access...");
    try {
      const access = await checkChatUrl({ data: { url, provider: sourceProvider } });
      recordAccessCheck(id, access.accessStatus, access.lastError);
      setFlash(access.message);
      setLog(formatAccessOpLog("recheck_url", access, { chatId: id }));
    } catch (error) {
      const failed = accessCheckException(url, error);
      setFlash(failed.message);
      setLog(formatExceptionLog("recheck_url", error, { chatId: id, url, provider: sourceProvider }));
    } finally {
      setBusyId(null);
    }
  }

  async function reimport(id: string) {
    const source = store.chatSources.find((row) => row.id === id);
    if (!source) return;
    setBusyId(id);
    setFlash("Importing...");
    try {
      if (source.importMethod === "URL" && source.sourceUrl) {
        const out = await importChatUrl({ data: { url: source.sourceUrl, provider: source.provider } });
        recordAccessCheck(id, out.access.accessStatus, out.access.lastError);
        if (!out.access.importAllowed) {
          setFlash(out.access.message);
          setLog(formatAccessOpLog("reimport_url", out.access, { chatId: id, rawBytes: out.rawContent.length }));
          return;
        }
        const built = buildChatSource({
          projectId,
          provider: out.access.provider,
          title: source.title,
          sourceUrl: source.sourceUrl,
          importMethod: "URL",
          accessStatus: out.access.accessStatus,
          importStatus: "IMPORTED",
          rawContent: out.rawContent,
        });
        replaceChatSource(id, built.source, built.messages);
        setFlash("Imported");
        setLog(
          formatImportOpLog({
            op: "reimport_url",
            ok: true,
            provider: built.source.provider,
            title: built.source.title,
            sourceUrl: source.sourceUrl,
            rawBytes: out.rawContent.length,
            messageCount: built.messages.length,
            access: out.access,
          }),
        );
        return;
      }
      const built = buildChatSource({
        projectId,
        provider: source.provider,
        title: source.title,
        sourceUrl: source.sourceUrl,
        importMethod: source.importMethod,
        accessStatus: source.accessStatus,
        importStatus: "IMPORTED",
        rawContent: source.rawContent,
      });
      replaceChatSource(id, built.source, built.messages);
      setFlash("Imported");
      setLog(
        formatImportOpLog({
          op: "reimport_local",
          ok: true,
          provider: built.source.provider,
          title: built.source.title,
          sourceUrl: source.sourceUrl,
          rawBytes: source.rawContent.length,
          messageCount: built.messages.length,
        }),
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Import failed.";
      setFlash(text);
      setLog(formatExceptionLog("reimport", error, { chatId: id, sourceUrl: source.sourceUrl, method: source.importMethod }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-2 text-lg">AI Chats</h2>
        <p className="max-w-measure text-muted">{HISTORY_NOT_CANONICAL}</p>
        <p className="max-w-measure text-sm text-faint">{PRIVACY_NOTE}</p>
        <p className="text-xs text-faint tabular-nums">
          {memory.included} of {memory.total} chats in project memory. Stored locally: {formatChars(bytes)}. No chat-count limit.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to="/p/$projectId/chats/url"
            params={{ projectId }}
            className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-accent bg-accent px-3.5 font-semibold text-accent-fg no-underline"
          >
            <Link2 className="size-4" aria-hidden="true" />
            Add Chat URL
          </Link>
          <Link
            to="/p/$projectId/chats/upload"
            params={{ projectId }}
            className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-line px-3.5 font-semibold text-fg no-underline"
          >
            <Upload className="size-4" aria-hidden="true" />
            Upload Conversation
          </Link>
          <Link
            to="/p/$projectId/chats/paste"
            params={{ projectId }}
            className="inline-flex min-h-11 items-center gap-2 rounded-sm border border-line px-3.5 font-semibold text-fg no-underline"
          >
            <ClipboardPaste className="size-4" aria-hidden="true" />
            Paste Conversation
          </Link>
        </div>
      </Panel>

      <Panel>
        <h2 className="font-display mb-3 text-lg">Search</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Keyword">
            <span className="relative block">
              <Search className="pointer-events-none absolute top-3.5 left-3 size-4 text-faint" aria-hidden="true" />
              <TextInput className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or content" />
            </span>
          </Field>
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Filter by title" />
          </Field>
          <Field label="Provider">
            <Select value={provider} onChange={(e) => setProvider(e.target.value as ChatProvider | "ALL")}>
              <option value="ALL">All providers</option>
              {PROVIDERS.map((row) => (
                <option key={row} value={row}>
                  {PROVIDER_LABEL[row]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
        {flash ? <p className="text-sm text-muted">{flash}</p> : null}
      </Panel>

      {rows.length === 0 ? (
        <p className="text-muted">No chat sources match this filter.</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {rows.map((source) => (
            <li key={source.id}>
              <ChatSourceCard
                projectId={projectId}
                source={source}
                busy={busyId === source.id}
                onRecheck={() => void recheck(source.id, source.sourceUrl, source.provider)}
                onReimport={() => void reimport(source.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <OpLogPanel
        title="Chat operation log"
        value={log}
        empty="Run Re-check or Re-import on a chat to capture a detailed log."
      />
    </>
  );
}
