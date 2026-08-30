import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { useState } from "react";
import { GhostButton, Panel } from "@/components/council-ui";

export function OpLogPanel({
  title = "Operation log",
  hint = "Copy this JSON if something fails and send it for diagnosis. Secrets are not included.",
  value,
  empty = "Run an action to capture a detailed log.",
}: {
  title?: string;
  hint?: string;
  value: string;
  empty?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const text = value || empty;

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
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg">{title}</h2>
          <p className="m-0 text-sm text-muted">{hint}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <GhostButton type="button" disabled={!value} onClick={() => setOpen((current) => !current)}>
            {open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
            {open ? "Collapse" : "Expand"}
          </GhostButton>
          <GhostButton type="button" disabled={!value} onClick={() => void onCopy()}>
            <Copy className="size-4" aria-hidden="true" />
            {copied ? "Copied" : "Copy log"}
          </GhostButton>
        </div>
      </div>
      {open ? (
        <textarea
          readOnly
          value={text}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          className="max-h-log min-h-40 w-full resize-y rounded-sm border border-line bg-bg px-3 py-3 font-mono text-sm leading-snug text-muted"
        />
      ) : (
        <textarea
          readOnly
          value={text}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
          className="max-h-preview min-h-24 w-full resize-none rounded-sm border border-line bg-bg px-3 py-3 font-mono text-sm leading-snug text-muted"
        />
      )}
    </Panel>
  );
}
