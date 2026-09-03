import { useLayoutEffect } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { BOOT_READY_SCRIPT, markClientReady } from "@/lib/boot-watchdog";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  useLayoutEffect(() => {
    markClientReady();
  }, []);
  return (
    <main
      data-cb-shell="error"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg"
    >
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />
      <span className="text-danger" aria-hidden="true">
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <h1 className="font-display text-lg font-semibold">Something went wrong</h1>
      <p className="max-w-md text-sm break-words text-muted">
        {error.message || "An unexpected error occurred. Try reloading the page."}
      </p>
    </main>
  );
}

export function DefaultPendingComponent() {
  useLayoutEffect(() => {
    markClientReady();
  }, []);
  return (
    <div
      data-cb-shell="boot"
      className="flex min-h-dvh flex-col items-center justify-center"
      style={{ background: "#0c0c0d", color: "#9a9a94" }}
    >
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />
      <p className="text-sm">Loading…</p>
    </div>
  );
}
