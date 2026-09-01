import { useMemo, useState } from "react";
import { GhostButton } from "@/components/council-ui";
import { formatChars, formatTokens } from "@/lib/history/format";
import { isTruncatedMarker } from "@/lib/evidence/pipeline";
import type { ProjectFile } from "@/lib/council/types";

export function FilePicker({
  projectId,
  files,
  selected,
  onChange,
}: {
  projectId: string;
  files: ProjectFile[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const rows = files.filter((row) => row.projectId === projectId);
  const memoryIds = rows.filter((row) => row.includeInMemory).map((row) => row.id);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (row) =>
        row.filename.toLowerCase().includes(needle) ||
        row.kind.toLowerCase().includes(needle) ||
        row.extractedText.toLowerCase().includes(needle) ||
        row.notes.toLowerCase().includes(needle),
    );
  }, [rows, query]);
  const chosen = rows.filter((row) => selected.includes(row.id));
  const tokens = chosen.reduce((sum, row) => sum + row.estimatedTokens, 0);

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((row) => row !== id) : [...selected, id]);
  }

  return (
    <fieldset className="m-0 grid gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium tracking-wider text-muted uppercase">Relevant project files</legend>
      <p className="m-0 text-sm text-faint">
        Files in project memory are selected by default. Selection is persisted on the task. Uploaded files stay untrusted
        evidence.
      </p>
      {rows.length ? (
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files"
          className="min-h-11 rounded-md border border-line bg-subtle px-3 text-sm text-fg"
        />
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted">No uploaded files in this project. Open the Files tab first.</p>
      ) : visible.length === 0 ? (
        <p className="text-muted">No files match that search.</p>
      ) : (
        <ul className="m-0 grid max-h-log list-none gap-2 overflow-auto p-0">
          {visible.map((file) => {
            const checked = selected.includes(file.id);
            const truncated = isTruncatedMarker(file.extractedText) || isTruncatedMarker(file.notes);
            return (
              <li key={file.id}>
                <label
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-3 text-sm ${
                    checked ? "border-accent bg-subtle" : "border-line bg-subtle"
                  }`}
                >
                  <input className="mt-1 size-4" type="checkbox" checked={checked} onChange={() => toggle(file.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-fg">{file.filename}</span>
                    <span className="ml-2 text-faint">{file.kind}</span>
                    {file.includeInMemory ? (
                      <span className="ml-2 text-xs tracking-wider text-ok uppercase">in memory</span>
                    ) : null}
                    {truncated ? (
                      <span className="ml-2 text-xs tracking-wider text-danger uppercase">reimport required</span>
                    ) : null}
                    <span className="mt-1 block text-xs text-faint tabular-nums">
                      {formatChars(file.characterCount)} · ~{formatTokens(file.estimatedTokens)}
                      {file.kind === "ZIP" ? ` · ${file.members.length} members` : ""}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length ? (
        <div className="flex flex-wrap gap-2">
          <GhostButton type="button" onClick={() => onChange(memoryIds)}>
            Select all project memory
          </GhostButton>
          <GhostButton type="button" onClick={() => onChange(rows.map((file) => file.id))}>
            Select all files
          </GhostButton>
          <GhostButton type="button" onClick={() => onChange([])}>
            Clear
          </GhostButton>
        </div>
      ) : null}
      <p className="m-0 text-sm tabular-nums text-fg">
        Selected: {chosen.length} file{chosen.length === 1 ? "" : "s"} · Estimated context: {formatTokens(tokens)}
      </p>
    </fieldset>
  );
}
