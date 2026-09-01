import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CollapsibleText } from "@/components/collapsible-text";
import { Field, GhostButton, Panel, PrimaryButton, StatusPill, TextArea } from "@/components/council-ui";
import {
  handOffImplementation,
  openImplementationReview,
  recordPacketImplementation,
} from "@/lib/council/store";
import { serializePacketHandoff } from "@/lib/council/packet";
import type { ImplementationPacket, ImplementationStatus } from "@/lib/council/types";

function List({ title, rows }: { title: string; rows: string[] }) {
  return (
    <>
      <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{title}</h3>
      {rows.length ? (
        <ul>
          {rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">None recorded.</p>
      )}
    </>
  );
}

export function ImplementationPacketPanel({ packet }: { packet: ImplementationPacket }) {
  const navigate = useNavigate();
  const [notes, setNotes] = useState(packet.implementationNotes ?? "");
  const [status, setStatus] = useState<ImplementationStatus>(packet.implementationStatus ?? "SUCCEEDED");
  const [copied, setCopied] = useState(false);
  const json = serializePacketHandoff(packet);

  async function copyHandoff() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function onHandOff() {
    handOffImplementation(packet.id);
  }

  function onRecord() {
    recordPacketImplementation(packet.id, { status, notes });
  }

  function onReview() {
    const task = openImplementationReview(packet.id);
    if (task) void navigate({ to: "/t/$taskId", params: { taskId: task.id } });
  }

  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Implementation packet</p>
      <h2 className="font-display mb-3 text-2xl">
        <StatusPill status={packet.status} /> iteration {packet.iteration}
      </h2>
      <p className="m-0 text-sm text-muted">
        Direct Build execution is unavailable. Copy this packet as the Build handoff. Do not simulate execution.
      </p>
      <p className="mt-3 mb-0 font-mono text-xs text-faint">
        {packet.id.slice(0, 8)} · hash {packet.packetHash}
        {packet.handoffAt ? ` · handed off ${packet.handoffAt}` : ""}
      </p>
      <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">Scope</h3>
      <CollapsibleText text={packet.scope} />
      <List title="Requirements" rows={packet.requirements} />
      <List title="Invariants" rows={packet.invariants} />
      <List title="Evidence refs" rows={packet.evidenceRefs} />
      <List title="Acceptance tests" rows={packet.acceptanceTests} />
      <List title="Blockers" rows={packet.blockers} />
      {packet.implementationStatus ? (
        <p className="mt-4 mb-0 text-sm">
          Implementation: <StatusPill status={packet.implementationStatus} /> {packet.implementationNotes}
        </p>
      ) : null}
      {packet.reviewTaskId ? (
        <p className="mt-3 mb-0 text-sm">
          Review task {packet.reviewTaskId.slice(0, 8)}
        </p>
      ) : null}
      <pre className="mt-4 max-h-64 overflow-auto rounded-md bg-subtle p-3 font-mono text-xs whitespace-pre-wrap text-muted">
        {json}
      </pre>
      <div className="mt-4 flex flex-wrap gap-2">
        <GhostButton type="button" onClick={() => void copyHandoff()}>
          {copied ? "Copied handoff JSON" : "Copy handoff JSON"}
        </GhostButton>
        {packet.status === "READY" ? (
          <PrimaryButton type="button" onClick={onHandOff}>
            Mark handed off
          </PrimaryButton>
        ) : null}
        {packet.status === "RESULT_RECORDED" ? (
          <PrimaryButton type="button" onClick={onReview}>
            Open Council REVIEW
          </PrimaryButton>
        ) : null}
      </div>
      {packet.status === "HANDED_OFF" || packet.status === "RESULT_RECORDED" ? (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onRecord();
          }}
        >
          <Field label="Implementation result">
            <select
              className="min-h-11 w-full rounded-sm border border-line bg-bg px-3 text-fg"
              value={status}
              onChange={(event) => setStatus(event.target.value as ImplementationStatus)}
            >
              <option value="SUCCEEDED">Succeeded</option>
              <option value="PARTIAL">Partial</option>
              <option value="FAILED">Failed</option>
            </select>
          </Field>
          <Field label="Implementation notes">
            <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </Field>
          <PrimaryButton type="submit">Record implementation</PrimaryButton>
        </form>
      ) : null}
    </Panel>
  );
}
