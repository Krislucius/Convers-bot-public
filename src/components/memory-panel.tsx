import { FormEvent, useState } from "react";
import { CollapsibleText } from "@/components/collapsible-text";
import { Field, Panel, PrimaryButton, Select, StatusPill, TextArea } from "@/components/council-ui";
import { addContext, useStore } from "@/lib/council/store";
import type { ContextKind, ContextStatus } from "@/lib/council/types";

export function MemoryPanel({
  projectId,
  kinds,
  title,
  allowAdd,
  lockKind,
  lockStatus,
}: {
  projectId: string;
  kinds: ContextKind[];
  title: string;
  allowAdd: boolean;
  lockKind?: ContextKind;
  lockStatus?: ContextStatus;
}) {
  const store = useStore();
  const items = store.context.filter((row) => row.projectId === projectId && kinds.includes(row.kind));
  const [kind, setKind] = useState<ContextKind>(lockKind ?? kinds[0] ?? "SPECIFICATION");
  const [status, setStatus] = useState<ContextStatus>(lockStatus ?? "ACTIVE");
  const [content, setContent] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    addContext(projectId, lockKind ?? kind, content.trim(), lockStatus ?? status);
    setContent("");
  }

  return (
    <Panel>
      <h2 className="font-display mb-3 text-lg">{title}</h2>
      {items.length === 0 ? (
        <p className="text-muted">Nothing recorded yet.</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((item) => (
            <li key={item.id} className="rounded-md bg-subtle p-3">
              <StatusPill status={item.kind} />
              <span className="ml-2">
                <StatusPill status={item.status} />
              </span>
              <div className="mt-2">
                <CollapsibleText text={item.content} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {allowAdd ? (
        <form className="mt-4 grid gap-3" onSubmit={onSubmit}>
          {lockKind ? null : (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Kind">
                <Select value={kind} onChange={(e) => setKind(e.target.value as ContextKind)}>
                  {kinds.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as ContextStatus)}>
                  <option>FROZEN</option>
                  <option>ACTIVE</option>
                </Select>
              </Field>
            </div>
          )}
          <Field label="Content">
            <TextArea value={content} onChange={(e) => setContent(e.target.value)} required />
          </Field>
          <PrimaryButton type="submit">Add</PrimaryButton>
        </form>
      ) : null}
    </Panel>
  );
}
