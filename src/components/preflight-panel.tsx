import { StatusPill } from "@/components/council-ui";

type PreflightView = {
  steps: Array<{
    id: string;
    label: string;
    status: string;
    latencyMs: number | null;
    error: string | null;
  }>;
};

export function PreflightPanel({ report }: { report: PreflightView | null | undefined }) {
  if (!report) return null;
  return (
    <div className="mb-4 rounded-md border border-line bg-subtle px-3 py-3">
      <p className="mb-2 text-xs font-semibold tracking-widest text-muted uppercase">Precheck</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {report.steps.map((step) => (
          <li key={step.id} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm">{step.label}</span>
            <span className="flex items-center gap-2">
              {step.latencyMs != null ? (
                <span className="font-mono text-xs tabular-nums text-faint">{step.latencyMs}ms</span>
              ) : null}
              <StatusPill status={step.status === "PASS" ? "VERIFIED" : step.status} />
            </span>
            {step.error ? <p className="m-0 w-full text-xs text-danger">{step.error}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
