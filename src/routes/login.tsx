import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import { LoginForm, StaySignedIn } from "@/components/login-form";
import { Page, PageHeader, Panel } from "@/components/council-ui";
import { SystemRevisionLine } from "@/components/system-info";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { beginAutoLand, shouldAutoLand } from "@/lib/auth-loop";
import { BOOT_READY_SCRIPT, markClientReady } from "@/lib/boot-watchdog";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: Login,
});

function Login() {
  const { user } = useCurrentUserState();
  const searchError = Route.useSearch({ select: (s) => s.error });

  useLayoutEffect(() => {
    markClientReady();
  }, []);

  useEffect(() => {
    if (!user) return;
    if (!beginAutoLand()) return;
    window.location.replace("/");
  }, [user]);

  function landInApp() {
    if (typeof window === "undefined") return;
    beginAutoLand();
    window.location.replace("/");
  }

  if (user && !shouldAutoLand()) {
    return (
      <div className="relative z-20" style={{ minHeight: "100dvh", background: "#0c0c0d", color: "#f1f1ef" }}>
        <script dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />
        <Page>
          <PageHeader title="Signed in">
            <p className="max-w-measure text-muted">Stop the sign-in loop and open your projects.</p>
          </PageHeader>
          <Panel className="relative z-20">
            <StaySignedIn />
          </Panel>
        </Page>
      </div>
    );
  }

  if (user) {
    return (
      <div
        data-cb-shell="boot"
        className="relative z-20"
        style={{ minHeight: "100dvh", background: "#0c0c0d", color: "#f1f1ef" }}
      >
        <script dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />
        <Page>
          <PageHeader title="Opening projects…">
            <p className="max-w-measure text-muted">Signed in. Loading your workspace.</p>
          </PageHeader>
        </Page>
      </div>
    );
  }

  return (
    <div
      data-cb-shell="guest"
      className="relative z-20"
      style={{ minHeight: "100dvh", background: "#0c0c0d", color: "#f1f1ef" }}
    >
      <script dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />
      <Page>
        <PageHeader title="Sign in">
          <p className="max-w-measure text-muted">
            Projects, imported chats, memory, and API keys stay on this account.
          </p>
        </PageHeader>
        <Panel className="relative z-20">
          <LoginForm searchError={searchError} onSignedIn={landInApp} />
        </Panel>
        <SystemRevisionLine className="mt-6 text-center" />
      </Page>
    </div>
  );
}
