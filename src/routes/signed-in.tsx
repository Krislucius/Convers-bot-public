import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Page, PageHeader } from "@/components/council-ui";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { SESSION_WAIT_MS, isAuthReturning, markAuthReturning, resetAuthHops } from "@/lib/auth-loop";
import { markClientReady } from "@/lib/boot-watchdog";

export const Route = createFileRoute("/signed-in")({ component: SignedInLanding });

function SignedInLanding() {
  const { user, isPending } = useCurrentUserState();
  const [giveUp, setGiveUp] = useState(false);

  useEffect(() => {
    markClientReady();
    markAuthReturning();
  }, []);

  useEffect(() => {
    if (user) {
      resetAuthHops();
      window.location.replace("/");
      return;
    }
    if (!isPending && !isAuthReturning()) {
      setGiveUp(true);
      return;
    }
    const timer = window.setTimeout(() => setGiveUp(true), SESSION_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [user, isPending]);

  useEffect(() => {
    if (giveUp && !user) window.location.replace("/");
  }, [giveUp, user]);

  return (
    <div
      data-cb-shell={giveUp ? "guest" : "boot"}
      className="relative z-20"
      style={{ minHeight: "100dvh", background: "#0c0c0d", color: "#f1f1ef" }}
    >
      <Page>
        <PageHeader title={giveUp ? "Opening the app…" : "Finishing sign-in…"}>
          <p className="max-w-measure text-muted">
            {giveUp ? "Continue to your workspace." : "Confirming this browser session."}
          </p>
        </PageHeader>
      </Page>
    </div>
  );
}
