import { useEffect } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { markClientReady } from "@/lib/boot-watchdog";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  useEffect(() => {
    markClientReady();
  }, []);
  return (
    <main
      data-cb-shell="error"
      className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg"
    >
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
