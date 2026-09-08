import { StatusPill } from "@/components/council-ui";
import { formatAgentCard } from "@/lib/council/agents";
import type { AgentProgress } from "@/lib/council/types";

export function AgentCard({
  label,
  progress,
}: {
  label: string;
  progress: AgentProgress | undefined;
}) {
  const row = progress ?? { state: "WAITING" as const, attempt: 0, maxAttempts: 3, error: null };
  const card = formatAgentCard(label, row);
  const shown = row.detail && row.detail !== row.state ? row.detail : card.status;
  return (
    <li className="rounded-md border border-line bg-subtle px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-fg">{card.title}</strong>
        <StatusPill status={shown} />
      </div>
      <p className="m-0 mt-1 font-mono text-xs tabular-nums text-faint">{card.attempts}</p>
      {row.latencyMs != null ? (
        <p className="m-0 mt-1 font-mono text-xs tabular-nums text-faint">{row.latencyMs}ms</p>
      ) : null}
      {card.lastError ? (
        <p className="m-0 mt-2 text-sm break-words text-danger">last error: {card.lastError}</p>
      ) : row.state === "RUNNING" || row.detail === "PROBING" ? (
        <p className="m-0 mt-1 text-xs text-faint">{row.detail === "PROBING" ? "probing" : "running"}</p>
      ) : row.state === "DONE" || row.detail === "VERIFIED" ? (
        <p className="m-0 mt-1 text-xs text-ok">{row.detail === "VERIFIED" ? "verified" : "recorded"}</p>
      ) : (
        <p className="m-0 mt-1 text-xs text-faint">{(row.detail ?? row.state).toLowerCase()}</p>
      )}
    </li>
  );
}
