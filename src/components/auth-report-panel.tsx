import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GhostButton } from "@/components/council-ui";
import { authTrace, clientAuthFlags, readAuthTrace, readDebugCookie } from "@/lib/auth-trace";
import { prettyJson } from "@/lib/op-log";

async function collectAuthReport(extra: Record<string, unknown>) {
  const flags = clientAuthFlags();
  let server: unknown = null;
  let serverError: string | null = null;
  const headers: Record<string, string> = { accept: "application/json" };
  try {
    const token = window.sessionStorage.getItem("grok-auth.bearer-token");
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  try {
    const response = await fetch("/api/auth-report", {
      credentials: "include",
      headers,
      signal: AbortSignal.timeout(4_000),
    });
    server = await response.json().catch(() => null);
    if (!response.ok) serverError = `http_${response.status}`;
  } catch (err) {
    serverError = err instanceof Error ? err.message : String(err);
  }
  return {
    title: "Conversation Bot · sign-in report",
    t: new Date().toISOString(),
    page: extra.page ?? flags.path,
    ...flags,
    debugCookie: readDebugCookie(),
    server,
    serverError,
    trace: readAuthTrace(),
    extra,
  };
}

export function AuthReportPanel({
  extra,
  defaultOpen = false,
}: {
  extra?: Record<string, unknown>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const extraKey = JSON.stringify(extra ?? {});
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (defaultOpen && detailsRef.current) detailsRef.current.open = true;
  }, [defaultOpen]);

  useEffect(() => {
    let cancelled = false;
    const payload = extra ?? {};
    authTrace("report.collect", { page: payload.page ?? null });
    void collectAuthReport(payload).then((report) => {
      if (!cancelled) setValue(prettyJson(report));
    });
    return () => {
      cancelled = true;
    };
    // extraKey is the stable snapshot of extra
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraKey]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void collectAuthReport(extra ?? {}).then((report) => {
      if (!cancelled) setValue(prettyJson(report));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, extraKey]);

  async function onCopy() {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <details
      className="my-6 rounded-xl border border-line bg-elevated"
      ref={detailsRef}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-semibold text-fg [&::-webkit-details-marker]:hidden [&::marker]:content-none">
        <span>Sign-in report (JSON)</span>
        <span className="inline-flex items-center gap-1 text-sm font-medium text-muted">
          {open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          {open ? "Collapse" : "Expand"}
        </span>
      </summary>
      <div className="grid gap-3 border-t border-line p-4">
        <p className="m-0 text-sm text-muted">
          Copy this if sign-in loops. Cookie values and secrets are not included.
        </p>
        <textarea
          readOnly
          value={value || "Collecting sign-in report…"}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          className="max-h-log min-h-40 w-full resize-y rounded-sm border border-line bg-bg px-3 py-3 font-mono text-sm leading-snug text-muted"
        />
        <div>
          <GhostButton type="button" disabled={!value} onClick={() => void onCopy()}>
            <Copy className="size-4" aria-hidden="true" />
            {copied ? "Copied" : "Copy log"}
          </GhostButton>
        </div>
      </div>
    </details>
  );
}
