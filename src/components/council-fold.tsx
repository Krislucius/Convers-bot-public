import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

export function CouncilFold({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-md border border-line bg-subtle">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm font-medium">
        <ChevronDown
          className="size-4 shrink-0 text-faint transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
        <span className="shrink-0 text-fg">{title}</span>
        {summary ? <span className="min-w-0 flex-1 truncate font-normal text-faint">{summary}</span> : null}
      </summary>
      <div className="border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}
