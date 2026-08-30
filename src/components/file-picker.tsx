import { GhostButton } from "@/components/council-ui";
import { formatChars, formatTokens } from "@/lib/history/format";
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
  const rows = files.filter((row) => row.projectId === projectId);
  const memoryIds = rows.filter((row) => row.includeInMemory).map((row) => row.id);
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
      {rows.length === 0 ? (
        <p className="text-muted">No uploaded files in this project. Open the Files tab first.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {rows.map((file) => {
            const checked = selected.includes(file.id);
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
