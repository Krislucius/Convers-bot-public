import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { GhostButton } from "@/components/council-ui";
import { useI18n } from "@/lib/i18n/provider";

const LONG_CHARS = 420;
const LONG_LINES = 8;

export function isLongText(text: string): boolean {
  return text.length > LONG_CHARS || text.split("\n").length > LONG_LINES;
}

export function CollapsibleText({
  text,
  defaultCollapsed,
  className = "",
  forceOpen,
}: {
  text: string;
  defaultCollapsed?: boolean;
  className?: string;
  forceOpen?: boolean | null;
}) {
  const { t } = useI18n();
  const long = isLongText(text);
  const [open, setOpen] = useState(!(defaultCollapsed ?? long));
  useEffect(() => {
    if (forceOpen == null) return;
    setOpen(forceOpen);
  }, [forceOpen]);
  const collapsed = long && !open;

  return (
    <div>
      <pre
        className={`m-0 font-mono text-sm leading-snug whitespace-pre-wrap text-muted ${
          collapsed ? "max-h-preview overflow-hidden" : ""
        } ${className}`}
      >
        {text}
      </pre>
      {long ? (
        <GhostButton type="button" className="mt-2" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
          {open ? t("text.collapse") : t("text.expand")}
        </GhostButton>
      ) : null}
    </div>
  );
}