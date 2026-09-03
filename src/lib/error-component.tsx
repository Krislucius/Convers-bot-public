import { useLayoutEffect } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { BOOT_READY_SCRIPT, markClientReady } from "@/lib/boot-watchdog";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  useLayoutEffect(() => {
    markClientReady();
  }, []);
  const message = error.message || "An unexpected error occurred. Try reloading the page.";
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
      <p className="max-w-md text-sm break-words text-muted">{message}</p>
      <button
        type="button"
        className="min-h-11 rounded-sm px-4 font-semibold"
        style={{ background: "#d7d4cc", color: "#0c0c0d" }}
        onClick={() => {
          location.reload();
        }}
      >
        Reload
      </button>
      <button
        type="button"
        className="min-h-11 rounded-sm border border-line px-4 font-semibold"
        onClick={() => {
          const go = () => {
            location.href = "/login?stay=1";
          };
          void fetch("/api/auth/sign-out", { method: "POST", credentials: "include" })
            .catch(() => undefined)
            .then(go);
        }}
      >
        Sign out
      </button>
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
