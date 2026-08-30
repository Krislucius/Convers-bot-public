import { GhostButton } from "@/components/council-ui";
import { PROVIDER_LABEL, formatChars, formatTokens } from "@/lib/history/format";
import { HISTORY_NOT_CANONICAL, memoryChatIds } from "@/lib/history/provenance";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export function SourcePicker({
  projectId,
  chats,
  messages,
  selected,
  onChange,
}: {
  projectId: string;
  chats: ChatSource[];
  messages: HistoryMessage[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const imported = chats.filter((row) => row.projectId === projectId && row.importStatus === "IMPORTED");
  const memoryIds = memoryChatIds(chats, projectId);
  const chosen = imported.filter((row) => selected.includes(row.id));
  const messageCount = chosen.reduce((sum, row) => {
    const n = messages.filter((turn) => turn.chatSourceId === row.id).length;
    return sum + (row.messageCount ?? n);
  }, 0);
  const tokens = chosen.reduce(
    (sum, row) => sum + (row.estimatedTokenCount ?? Math.ceil(row.characterCount / 4)),
    0,
  );

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((row) => row !== id) : [...selected, id]);
  }

  return (
    <fieldset className="m-0 grid gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium tracking-wider text-muted uppercase">Relevant AI Chats</legend>
      <p className="m-0 text-sm text-faint">{HISTORY_NOT_CANONICAL} Chats in project memory are selected by default.</p>
      {imported.length === 0 ? (
        <p className="text-muted">No imported chats in this project.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {imported.map((chat) => {
            const checked = selected.includes(chat.id);
            return (
              <li key={chat.id}>
                <label
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-sm ${
                    checked ? "border-accent bg-subtle" : "border-line bg-subtle"
                  }`}
                >
                  <input className="mt-1 size-4" type="checkbox" checked={checked} onChange={() => toggle(chat.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{chat.title}</span>
                    <span className="ml-2 text-faint">{PROVIDER_LABEL[chat.provider]}</span>
                    {chat.includeInMemory ? (
                      <span className="ml-2 text-xs tracking-wider text-ok uppercase">in memory</span>
                    ) : null}
                    <span className="mt-1 block text-xs text-faint tabular-nums">
                      {chat.messageCount ?? 0} messages · {formatChars(chat.characterCount)}
                      {chat.estimatedTokenCount != null ? ` · ~${formatTokens(chat.estimatedTokenCount)}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {imported.length ? (
        <div className="flex flex-wrap gap-2">
          <GhostButton type="button" onClick={() => onChange(memoryIds)}>
            Select all project memory
          </GhostButton>
          <GhostButton type="button" onClick={() => onChange(imported.map((chat) => chat.id))}>
            Select all imported
          </GhostButton>
          <GhostButton type="button" onClick={() => onChange([])}>
            Clear
          </GhostButton>
        </div>
      ) : null}
      <p className="m-0 text-sm tabular-nums text-fg">
        Selected: {chosen.length} chat{chosen.length === 1 ? "" : "s"} · Messages: {messageCount} · Estimated context:{" "}
        {formatTokens(tokens)}
      </p>
    </fieldset>
  );
}
