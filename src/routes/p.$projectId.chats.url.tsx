import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { FormEvent, useState } from "react";
import { DuplicateImport, type DuplicateChoice } from "@/components/duplicate-import";
import { OpLogPanel } from "@/components/op-log";
import { ProviderField } from "@/components/provider-field";
import { Field, Panel, PrimaryButton, StatusPill, TextInput } from "@/components/council-ui";
import { addChatSource, replaceChatSource, useStore } from "@/lib/council/store";
import { buildChatSource } from "@/lib/history/build-source";
import { accessCheckException } from "@/lib/history/access";
import { HISTORY_NOT_CANONICAL, PRIVACY_NOTE } from "@/lib/history/format";
import { findDuplicate } from "@/lib/history/provenance";
import { checkChatUrl, importChatUrl } from "@/lib/history/run-history";
import { hashContent } from "@/lib/history/hash";
import { formatAccessOpLog, formatExceptionLog, formatImportOpLog } from "@/lib/op-log";
import type { AccessCheckResult, ChatProvider, ChatSource } from "@/lib/history/types";

export const Route = createFileRoute("/p/$projectId/chats/url")({ component: AddUrlPage });

function AddUrlPage() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [provider, setProvider] = useState<ChatProvider | "AUTO">("AUTO");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [log, setLog] = useState("");
  const [access, setAccess] = useState<AccessCheckResult | null>(null);
  const [pending, setPending] = useState<{ source: ChatSource; messages: ReturnType<typeof buildChatSource>["messages"]; duplicate?: ChatSource } | null>(null);

  async function onCheck(e?: FormEvent) {
    e?.preventDefault();
    setChecking(true);
    setStatus("Checking access...");
    setAccess(null);
    try {
      const result = await checkChatUrl({ data: { url, provider } });
      setAccess(result);
      setStatus(result.message);
      setLog(formatAccessOpLog("check_url", result));
    } catch (error) {
      const failed = accessCheckException(url, error);
      setAccess(failed);
      setStatus(failed.message);
      setLog(formatExceptionLog("check_url", error, { url, provider }));
    } finally {
      setChecking(false);
    }
  }

  async function onImport() {
    if (!access?.importAllowed) return;
    setImporting(true);
    setStatus("Importing...");
    try {
      const out = await importChatUrl({ data: { url, provider } });
      setAccess(out.access);
      if (!out.access.importAllowed) {
        setStatus(out.access.message);
        setLog(formatAccessOpLog("import_url", out.access, { rawBytes: out.rawContent.length }));
        return;
      }
      const built = buildChatSource({
        projectId,
        provider: out.access.provider,
        title: title || out.access.titleHint || "",
        sourceUrl: out.access.requestedUrl,
        importMethod: "URL",
        accessStatus: out.access.accessStatus,
        importStatus: "IMPORTED",
        rawContent: out.rawContent,
      });
      const duplicate = findDuplicate(store.chatSources, projectId, hashContent(out.rawContent));
      setLog(
        formatImportOpLog({
          op: "import_url",
          ok: true,
          provider: built.source.provider,
          title: built.source.title,
          sourceUrl: built.source.sourceUrl,
          rawBytes: out.rawContent.length,
          messageCount: built.messages.length,
          duplicate: Boolean(duplicate),
          access: out.access,
        }),
      );
      if (duplicate) {
        setPending({ source: built.source, messages: built.messages, duplicate });
        setStatus("This content appears to already exist in this project.");
        return;
      }
      addChatSource(built.source, built.messages);
      void navigate({ to: "/p/$projectId/chats/$chatId", params: { projectId, chatId: built.source.id } });
    } catch (error) {
      const failed = accessCheckException(url, error);
      setAccess(failed);
      setStatus(failed.message);
      setLog(formatExceptionLog("import_url", error, { url, provider }));
    } finally {
      setImporting(false);
    }
  }

  function onDuplicate(choice: DuplicateChoice) {
    if (!pending) return;
    if (choice === "cancel") {
      setPending(null);
      setStatus("");
      return;
    }
    if (choice === "replace" && pending.duplicate) {
      replaceChatSource(pending.duplicate.id, pending.source, pending.messages);
      void navigate({ to: "/p/$projectId/chats/$chatId", params: { projectId, chatId: pending.duplicate.id } });
      return;
    }
    addChatSource(pending.source, pending.messages);
    void navigate({ to: "/p/$projectId/chats/$chatId", params: { projectId, chatId: pending.source.id } });
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-2 text-lg">Add Chat URL</h2>
        <p className="text-muted">{PRIVACY_NOTE}</p>
        <p className="text-sm text-faint">{HISTORY_NOT_CANONICAL} A URL is not imported until access is checked and the page is actually readable. Public ChatGPT <span className="font-mono">/share/…</span> links work. Private <span className="font-mono">/c/…</span> chats cannot be read without cookies — use Upload or Paste for those.</p>
        <form className="mt-4 grid gap-3" onSubmit={(e) => void onCheck(e)}>
          <Field label="Chat URL">
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://chatgpt.com/share/…"
              required
            />
          </Field>
          <ProviderField value={provider} onChange={setProvider} />
          <Field label="Title" hint="Optional. Detected from the page when left blank.">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="submit" disabled={checking || !url.trim()}>
              {checking ? "Checking…" : "Check Access"}
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

      {access ? (
        <Panel>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <StatusPill status={access.accessStatus} />
            {access.httpStatus ? <span className="text-sm text-faint">HTTP {access.httpStatus}</span> : null}
            {typeof access.fetchedBytes === "number" ? (
              <span className="text-sm text-faint">{access.fetchedBytes.toLocaleString()} bytes{access.truncated ? " · truncated" : ""}</span>
            ) : null}
          </div>
          <p className="text-muted">{access.message}</p>
          {access.titleHint ? <p className="text-sm text-faint">Detected title: {access.titleHint}</p> : null}
          {access.lastError && access.lastError !== access.message ? (
            <p className="text-sm text-danger">{access.lastError}</p>
          ) : null}
          {access.importAllowed ? (
            <PrimaryButton type="button" disabled={importing} onClick={() => void onImport()}>
              {importing ? "Importing…" : "Import conversation"}
            </PrimaryButton>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                to="/p/$projectId/chats/upload"
                params={{ projectId }}
                className="inline-flex min-h-11 items-center rounded-sm border border-accent bg-accent px-3.5 font-semibold text-accent-fg no-underline"
              >
                Upload Conversation
              </Link>
              <Link
                to="/p/$projectId/chats/paste"
                params={{ projectId }}
                className="inline-flex min-h-11 items-center rounded-sm border border-line px-3.5 font-semibold text-fg no-underline"
              >
                Paste Conversation
              </Link>
            </div>
          )}
        </Panel>
      ) : null}

      {pending?.duplicate ? <DuplicateImport existing={pending.duplicate} onChoose={onDuplicate} /> : null}

      {status && !access ? <p className="text-sm text-muted">{status}</p> : null}

      <OpLogPanel title="Access check log" value={log} empty="Run Check Access to capture a detailed log." />
    </>
  );
}
