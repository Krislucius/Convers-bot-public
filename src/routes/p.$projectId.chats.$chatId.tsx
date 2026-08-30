import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { ChatSourceCard } from "@/components/chat-source-card";
import { CollapsibleText } from "@/components/collapsible-text";
import { OpLogPanel } from "@/components/op-log";
import { Panel } from "@/components/council-ui";
import { recordAccessCheck, replaceChatSource, useStore } from "@/lib/council/store";
import { buildChatSource } from "@/lib/history/build-source";
import { HISTORY_NOT_CANONICAL, formatWhen } from "@/lib/history/format";
import { messagesForSource } from "@/lib/history/provenance";
import { checkChatUrl, importChatUrl } from "@/lib/history/run-history";
import { accessCheckException } from "@/lib/history/access";
import { formatAccessOpLog, formatExceptionLog, formatImportOpLog } from "@/lib/op-log";

export const Route = createFileRoute("/p/$projectId/chats/$chatId")({ component: ChatDetailPage });

function ChatDetailPage() {
  const { projectId, chatId } = Route.useParams();
  const store = useStore();
  const source = store.chatSources.find((row) => row.id === chatId && row.projectId === projectId);
  const messages = source ? messagesForSource(store.historyMessages, source.id) : [];
  const [flash, setFlash] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  if (!source) {
    return <p className="text-danger">Chat source not found in this project.</p>;
  }

  const current = source;

  async function recheck() {
    if (!current.sourceUrl) return;
    setBusy(true);
    setFlash("Checking access...");
    try {
      const access = await checkChatUrl({ data: { url: current.sourceUrl, provider: current.provider } });
      recordAccessCheck(current.id, access.accessStatus, access.lastError);
      setFlash(access.message);
      setLog(formatAccessOpLog("recheck_url", access, { chatId: current.id }));
    } catch (error) {
      const failed = accessCheckException(current.sourceUrl, error);
      setFlash(failed.message);
      setLog(formatExceptionLog("recheck_url", error, { chatId: current.id, url: current.sourceUrl }));
    } finally {
      setBusy(false);
    }
  }

  async function reimport() {
    setBusy(true);
    setFlash("Importing...");
    try {
      if (current.importMethod === "URL" && current.sourceUrl) {
        const out = await importChatUrl({ data: { url: current.sourceUrl, provider: current.provider } });
        recordAccessCheck(current.id, out.access.accessStatus, out.access.lastError);
        if (!out.access.importAllowed) {
          setFlash(out.access.message);
          setLog(formatAccessOpLog("reimport_url", out.access, { chatId: current.id, rawBytes: out.rawContent.length }));
          return;
        }
        const built = buildChatSource({
          projectId,
          provider: out.access.provider,
          title: current.title,
          sourceUrl: current.sourceUrl,
          importMethod: "URL",
          accessStatus: out.access.accessStatus,
          importStatus: "IMPORTED",
          rawContent: out.rawContent,
        });
        replaceChatSource(current.id, built.source, built.messages);
        setFlash("Imported");
        setLog(
          formatImportOpLog({
            op: "reimport_url",
            ok: true,
            provider: built.source.provider,
            title: built.source.title,
            sourceUrl: current.sourceUrl,
            rawBytes: out.rawContent.length,
            messageCount: built.messages.length,
            access: out.access,
          }),
        );
        return;
      }
      const built = buildChatSource({
        projectId,
        provider: current.provider,
        title: current.title,
        sourceUrl: current.sourceUrl,
        importMethod: current.importMethod,
        accessStatus: current.accessStatus,
        importStatus: "IMPORTED",
        rawContent: current.rawContent,
      });
      replaceChatSource(current.id, built.source, built.messages);
      setFlash("Imported");
      setLog(
        formatImportOpLog({
          op: "reimport_local",
          ok: true,
          provider: built.source.provider,
          title: built.source.title,
          sourceUrl: current.sourceUrl,
          rawBytes: current.rawContent.length,
          messageCount: built.messages.length,
        }),
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : "Import failed.";
      setFlash(text);
      setLog(formatExceptionLog("reimport", error, { chatId: current.id, sourceUrl: current.sourceUrl }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mb-4 text-sm">
        <Link to="/p/$projectId/chats" params={{ projectId }} className="text-muted">
          All AI Chats
        </Link>
      </p>
      <ChatSourceCard
        projectId={projectId}
        source={source}
        busy={busy}
        onRecheck={() => void recheck()}
        onReimport={() => void reimport()}
      />
      {flash ? <p className="text-sm text-muted">{flash}</p> : null}

      <Panel>
        <h2 className="font-display mb-2 text-lg">Provenance</h2>
        <p className="text-muted">{HISTORY_NOT_CANONICAL}</p>
        {source.sourceUrl ? (
          <p className="break-all text-sm text-faint">
            Remote URL: {source.sourceUrl}
            {source.importedAt ? ` · kept since ${formatWhen(source.importedAt)}` : null}
          </p>
        ) : (
          <p className="text-sm text-faint">No remote URL. This source was uploaded or pasted.</p>
        )}
      </Panel>

      <Panel>
        <h2 className="font-display mb-3 text-lg">Parsed messages</h2>
        {messages.length === 0 ? (
          <p className="text-muted">Reliable message boundaries could not be parsed. Raw content is preserved.</p>
        ) : (
          <ol className="m-0 grid list-none gap-3 p-0">
            {messages.map((row) => (
              <li key={row.id} className="rounded-md bg-subtle p-3">
                <p className="mt-0 mb-1 text-xs tracking-wider text-faint uppercase">
                  {row.sequence + 1}. {row.speaker} · {row.role}
                  {row.timestamp ? ` · ${formatWhen(row.timestamp)}` : ""}
                </p>
                <CollapsibleText text={row.content} />
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <details className="my-4 rounded-xl border border-line bg-elevated p-5">
        <summary className="cursor-pointer font-semibold">Raw original</summary>
        <div className="mt-3">
          <CollapsibleText text={source.rawContent} defaultCollapsed />
        </div>
      </details>

      <OpLogPanel
        title="Chat operation log"
        value={log}
        empty="Run Re-check or Re-import to capture a detailed log."
      />
    </>
  );
}
