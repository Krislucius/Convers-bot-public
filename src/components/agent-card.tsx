import { StatusPill } from "@/components/council-ui";
import { formatAgentCard } from "@/lib/council/agents";
import type { AgentProgress } from "@/lib/council/types";
import { useI18n } from "@/lib/i18n/provider";

export function AgentCard({
  label,
  progress,
}: {
  label: string;
  progress: AgentProgress | undefined;
}) {
  const { t } = useI18n();
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
        <p className="m-0 mt-2 text-sm break-words text-danger">{t("agent.lastError", { error: card.lastError })}</p>
      ) : row.state === "RUNNING" || row.detail === "PROBING" ? (
        <p className="m-0 mt-1 text-xs text-faint">{row.detail === "PROBING" ? t("agent.probing") : t("agent.running")}</p>
      ) : row.state === "DONE" || row.detail === "VERIFIED" ? (
        <p className="m-0 mt-1 text-xs text-ok">{row.detail === "VERIFIED" ? t("agent.verified") : t("agent.recorded")}</p>
      ) : (
        <p className="m-0 mt-1 text-xs text-faint">{(row.detail ?? row.state).toLowerCase()}</p>
      )}
    </li>
  );
}