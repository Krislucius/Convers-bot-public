import { Link } from "@tanstack/react-router";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { DangerButton, GhostButton, StatusPill } from "@/components/council-ui";
import { deleteChatSource, renameChatSource, setChatArchived, setChatIncludeInMemory } from "@/lib/council/store";
import { METHOD_LABEL, PROVIDER_LABEL, formatChars, formatWhen } from "@/lib/history/format";
import type { ChatSource } from "@/lib/history/types";

export function ChatSourceCard({
  projectId,
  source,
  onRecheck,
  onReimport,
  busy,
}: {
  projectId: string;
  source: ChatSource;
  onRecheck?: () => void;
  onReimport?: () => void;
  busy?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(source.title);
  const archived = source.importStatus === "ARCHIVED";

  return (
    <article className={`grid gap-3 rounded-lg border border-line bg-subtle p-4 ${archived ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {renaming ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) renameChatSource(source.id, title.trim());
                setRenaming(false);
              }}
            >
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="min-h-11 min-w-48 rounded-sm border border-line bg-bg px-3 text-fg"
                aria-label="Title"
              />
              <GhostButton type="submit">Save</GhostButton>
              <GhostButton type="button" onClick={() => setRenaming(false)}>
                Cancel
              </GhostButton>
            </form>
          ) : (
            <h3 className="font-display m-0 text-lg">{source.title}</h3>
          )}
          <p className="mt-1 mb-0 text-sm text-muted">
            {PROVIDER_LABEL[source.provider]} · {METHOD_LABEL[source.importMethod]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill status={source.accessStatus} />
          <StatusPill status={source.importStatus} />
        </div>
      </div>

      <div className="grid gap-1 sm:grid-cols-2">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md bg-bg px-3 text-sm text-fg">
          <input
            type="checkbox"
            checked={source.includeInMemory && !archived}
            disabled={archived}
            onChange={(e) => setChatIncludeInMemory(source.id, e.target.checked)}
          />
          Include in project memory
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md bg-bg px-3 text-sm text-fg">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setChatArchived(source.id, e.target.checked)}
          />
          Archived
        </label>
      </div>

      <dl className="m-0 grid gap-2 text-sm text-muted sm:grid-cols-2">
        <div>
          <dt className="text-xs tracking-wider text-faint uppercase">Messages</dt>
          <dd className="m-0 tabular-nums">{source.messageCount ?? "Raw only"}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wider text-faint uppercase">Imported size</dt>
          <dd className="m-0 tabular-nums">{formatChars(source.characterCount)}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wider text-faint uppercase">Imported at</dt>
          <dd className="m-0">{formatWhen(source.importedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs tracking-wider text-faint uppercase">Last checked</dt>
          <dd className="m-0">{formatWhen(source.lastAccessCheckAt)}</dd>
        </div>
      </dl>

      {source.lastError ? <p className="m-0 text-sm text-danger">{source.lastError}</p> : null}

      {source.accessStatus === "AUTH_REQUIRED" && source.importStatus === "IMPORTED" ? (
        <p className="m-0 rounded-md bg-bg p-3 text-sm text-warn">
          Imported content is kept locally. Remote source now requires authentication.
        </p>
      ) : null}

      {confirmDelete ? (
        <div className="rounded-md border border-danger p-3">
          <p className="mt-0 mb-3 text-sm">Delete this chat source? This cannot be undone.</p>
          <div className="flex flex-wrap gap-2">
            <DangerButton type="button" onClick={() => deleteChatSource(source.id)}>
              Delete
            </DangerButton>
            <GhostButton type="button" onClick={() => setConfirmDelete(false)}>
              Cancel
            </GhostButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Link
            to="/p/$projectId/chats/$chatId"
            params={{ projectId, chatId: source.id }}
            className="inline-flex min-h-11 items-center justify-center rounded-sm border border-accent bg-accent px-3.5 font-semibold text-accent-fg no-underline"
          >
            Open
          </Link>
          {source.importMethod === "URL" ? (
            <GhostButton type="button" disabled={busy} onClick={onRecheck}>
              <RefreshCw className="size-4" aria-hidden="true" />
              Re-check access
            </GhostButton>
          ) : null}
          <GhostButton type="button" disabled={busy} onClick={onReimport}>
            Re-import
          </GhostButton>
          <GhostButton type="button" onClick={() => setRenaming(true)}>
            <Pencil className="size-4" aria-hidden="true" />
            Rename
          </GhostButton>
          <DangerButton type="button" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-4" aria-hidden="true" />
            Delete
          </DangerButton>
        </div>
      )}
    </article>
  );
}
