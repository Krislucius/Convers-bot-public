import { Panel } from "@/components/council-ui";
import { systemIdentity } from "@/lib/architecture/identity";

export function SystemRevisionLine({ className = "" }: { className?: string }) {
  const id = systemIdentity();
  return (
    <p className={`m-0 font-mono text-xs text-muted ${className}`.trim()}>
      {id.architectureRevision} · {id.buildId} · {id.sourceCommit} · schema {id.schemaVersion}
    </p>
  );
}

export function SystemInfoPanel() {
  const id = systemIdentity();
  const rows: Array<[string, string]> = [
    ["Project ID", id.projectId],
    ["Production host", id.productionHost],
    ["Architecture revision", id.architectureRevision],
    ["Build ID", id.buildId],
    ["Source commit", id.sourceCommit],
    ["Build timestamp", id.buildTimestamp],
    ["Schema version", id.schemaVersion],
  ];
  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">System information</p>
      <h2 className="font-display mt-0 mb-4 text-xl">Running architecture</h2>
      <dl className="m-0 grid gap-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1">
            <dt className="text-xs font-semibold tracking-widest text-muted uppercase">{label}</dt>
            <dd className="m-0 break-all font-mono text-sm text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
