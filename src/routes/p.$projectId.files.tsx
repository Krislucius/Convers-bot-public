import { createFileRoute } from "@tanstack/react-router";
import { Upload } from "lucide-react";
import { FormEvent, useRef, useState } from "react";
import { Field, GhostButton, Panel, PrimaryButton } from "@/components/council-ui";
import { FileParseError, parseProjectFile, previewExtractedText } from "@/lib/council/files";
import { nid } from "@/lib/council/protocol";
import { addProjectFile, deleteProjectFile, setFileIncludeInMemory, useStore } from "@/lib/council/store";
import type { ProjectFile } from "@/lib/council/types";
import { formatChars, formatTokens } from "@/lib/history/format";
import { sourceNeedsReimport } from "@/lib/evidence/pipeline";

export const Route = createFileRoute("/p/$projectId/files")({ component: FilesPage });

const FILES_NOTE =
  "Upload .zip, .pdf, or .md. Extracted text is untrusted evidence — it does not become a frozen invariant, active decision, or current project state. Zip members are never executed. Select files on a new task to send them to Council.";

function FilesPage() {
  const { projectId } = Route.useParams();
  const store = useStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [includeInMemory, setIncludeInMemory] = useState(true);
  const rows = store.projectFiles.filter((row) => row.projectId === projectId);
  const memoryCount = rows.filter((row) => row.includeInMemory).length;
  const bytes = rows.reduce((sum, row) => sum + row.characterCount, 0);

  async function ingest(file: File) {
    setBusy(true);
    setFlash("Reading file…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = await parseProjectFile(bytes, file.name);
      const row: ProjectFile = {
        id: nid(),
        projectId,
        filename: parsed.filename,
        kind: parsed.kind,
        extractedText: parsed.extractedText,
        members: parsed.members,
        notes: parsed.notes,
        sizeBytes: parsed.sizeBytes,
        characterCount: parsed.characterCount,
        estimatedTokens: parsed.estimatedTokens,
        includeInMemory,
        createdAt: new Date().toISOString(),
      };
      addProjectFile(row);
      setFlash(`${parsed.filename} uploaded · ${formatChars(parsed.characterCount)}`);
    } catch (error) {
      const text = error instanceof FileParseError ? error.message : error instanceof Error ? error.message : "Upload failed.";
      setFlash(text);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setFlash("Choose a .zip, .pdf, or .md file first.");
      return;
    }
    void ingest(file);
  }

  return (
    <>
      <Panel>
        <h2 className="font-display mb-2 text-lg">Files</h2>
        <p className="max-w-measure text-muted">{FILES_NOTE}</p>
        <p className="text-xs text-faint tabular-nums">
          {memoryCount} of {rows.length} files in project memory. Stored on this account: {formatChars(bytes)}.
        </p>
        <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
          <Field label="Project file">
            <input
              ref={inputRef}
              type="file"
              name="file"
              accept=".zip,.pdf,.md,.markdown,application/zip,application/pdf,text/markdown,text/plain"
              className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 py-2 text-sm text-fg file:mr-3 file:rounded-sm file:border-0 file:bg-accent file:px-3 file:py-2 file:font-semibold file:text-accent-fg"
              required
            />
          </Field>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line bg-subtle px-3 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={includeInMemory}
              onChange={(e) => setIncludeInMemory(e.target.checked)}
            />
            Include in project memory
          </label>
          <PrimaryButton type="submit" id="upload-files-btn" disabled={busy}>
            <Upload className="size-4" aria-hidden="true" />
            Upload Files
          </PrimaryButton>
          {flash ? <p className="m-0 text-sm text-muted">{flash}</p> : null}
        </form>
      </Panel>

      {rows.length === 0 ? (
        <p className="text-muted">No project files yet. 0 files in project memory.</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md border border-line bg-elevated p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="m-0 font-medium text-fg">{row.filename}</p>
                  <p className="m-0 mt-1 text-xs tracking-wider text-faint uppercase">
                    {row.kind}
                    {row.includeInMemory ? " · in memory" : ""}
                    {row.kind === "ZIP" ? ` · ${row.members.length} members` : ""}
                  </p>
                  <p className="m-0 mt-1 text-xs text-faint tabular-nums">
                    {formatChars(row.characterCount)} · ~{formatTokens(row.estimatedTokens)} · {row.sizeBytes} bytes
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <GhostButton type="button" onClick={() => setFileIncludeInMemory(row.id, !row.includeInMemory)}>
                    {row.includeInMemory ? "Remove from memory" : "Include in memory"}
                  </GhostButton>
                  <GhostButton type="button" onClick={() => deleteProjectFile(row.id)}>
                    Remove
                  </GhostButton>
                </div>
              </div>
              {sourceNeedsReimport({
                kind: "FILE",
                extractedText: row.extractedText,
                notes: row.notes,
                messages: 0,
              }) ? (
                <p className="mt-3 mb-0 text-sm text-danger">
                  Re-import required. Previously truncated text cannot be recovered for the Evidence Ledger.
                </p>
              ) : null}
              {row.extractedText ? (
                <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-subtle p-3 text-xs whitespace-pre-wrap text-muted">
                  {previewExtractedText(row.extractedText).slice(0, 400)}
                  {row.extractedText.length > 400 ? "…" : ""}
                </pre>
              ) : null}
              <p className="mb-0 mt-2 text-xs text-faint">{row.notes}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
