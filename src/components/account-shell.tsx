import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState, type AppUser } from "@/lib/auth/use-current-user";
import { authTrace } from "@/lib/auth-trace";
import { importAccountSnapshot, loadAccountHydrate } from "@/lib/council/account";
import { loadHydratePayload, withTimeout, HYDRATE_TIMEOUT_MS } from "@/lib/council/hydrate";
import { useSession } from "@/lib/council/session";
import { bindAccountStore, hydrateStore, readLegacyLocalStore } from "@/lib/council/store";
import { signOut } from "@/lib/auth/client";
import {
  accountShellKind,
  clearAuthReturning,
  isAuthReturning,
  resetAuthHops,
  SESSION_WAIT_MS,
} from "@/lib/auth-loop";
import { BOOT_READY_SCRIPT, markClientReady } from "@/lib/boot-watchdog";
import { LoginForm } from "@/components/login-form";
import { SystemRevisionLine } from "@/components/system-info";
import { readBakedSessionUser } from "@/lib/auth/session-bootstrap";


export type SsrSessionUser = { id: string; email: string | null } | null;
export { markAuthReturning, clearAuthReturning, isAuthReturning } from "@/lib/auth-loop";

const EMPTY_SNAPSHOT = {
  projects: [],
  context: [],
  tasks: [],
  responses: [],
  results: [],
  chatSources: [],
  historyMessages: [],
  projectFiles: [],
  artifacts: [],
  manifests: [],
  packets: [],
};

function initialBakedUser(): SsrSessionUser {
  if (typeof window === "undefined") return null;
  return readBakedSessionUser();
}

const BOOT_STYLE: CSSProperties = {
  minHeight: "100dvh",
  background: "#0c0c0d",
  color: "#9a9a94",
};

function ShellReadyScript() {
  return <script dangerouslySetInnerHTML={{ __html: BOOT_READY_SCRIPT }} />;
}

export function BootScreen({ label }: { label: string }) {
  useLayoutEffect(() => {
    markClientReady();
  }, []);
  return (
    <div
      data-cb-shell="boot"
      className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-16"
      style={BOOT_STYLE}
    >
      <ShellReadyScript />
      <div className="h-10 w-40 animate-pulse rounded-md bg-subtle" />
      <p className="text-sm text-muted">{label}</p>
      <SystemRevisionLine className="text-center" />
    </div>
  );
}

function GuestGate() {
  useLayoutEffect(() => {
    markClientReady();
    authTrace("guest-gate", {});
  }, []);
  return (
    <div
      data-cb-shell="guest"
      className="flex flex-1 flex-col items-center justify-center gap-5 px-4 py-16"
      style={BOOT_STYLE}
    >
      <ShellReadyScript />
      <div className="grid w-full max-w-md gap-3">
        <h1
          className="font-display text-center text-display font-semibold"
          style={{ color: "#f1f1ef", fontFamily: 'Palatino, "Palatino Linotype", Georgia, serif' }}
        >
          Conversation Bot
        </h1>
        <p className="text-center text-sm" style={{ color: "#9a9a94" }}>
          Sign in to open your projects, chats, memory, and API keys.
        </p>
        <LoginForm />
        <SystemRevisionLine className="text-center" />
      </div>
    </div>
  );
}

function fromSsr(sessionUser: SsrSessionUser): AppUser | null {
  if (!sessionUser) return null;
  return {
    id: sessionUser.id,
    displayName: sessionUser.email,
    primaryEmail: sessionUser.email,
    profileImageUrl: null,
    isDevFallback: false,
  };
}

export function SignedInApp({
  sessionUser,
  children,
}: {
  sessionUser: SsrSessionUser;
  children: ReactNode;
}) {
  const { user, isPending } = useCurrentUserState();
  const [bakedUser, setBakedUser] = useState<SsrSessionUser>(initialBakedUser);
  const ssrUser = sessionUser ?? bakedUser;
  const authed = user ?? fromSsr(ssrUser);
  const [clientWait, setClientWait] = useState(false);
  const returning = isAuthReturning();
  const kind = accountShellKind({ sessionUser: ssrUser, user });

  useLayoutEffect(() => {
    markClientReady();
    const baked = readBakedSessionUser();
    if (baked) setBakedUser(baked);
  }, []);

  useEffect(() => {
    authTrace("app.mount", {
      hasSsrUser: Boolean(sessionUser),
      hasClientUser: Boolean(user),
      isPending,
      returning,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount snapshot only
  }, []);

  useEffect(() => {
    if (authed) {
      setClientWait(false);
      return;
    }
    if (!returning) {
      setClientWait(false);
      return;
    }
    setClientWait(true);
    const timer = window.setTimeout(() => {
      authTrace("app.give-up", { isPending, returning });
      setClientWait(false);
    }, SESSION_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [authed, isPending, returning]);

  if (kind === "hydrator" && authed) {
    return (
      <AccountHydrator userId={authed.id} onReady={onAccountReady}>
        {children}
      </AccountHydrator>
    );
  }
  if (clientWait) {
    return <BootScreen label={returning ? "Signing you in…" : "Checking your account…"} />;
  }
  return <GuestGate />;
}

function onAccountReady() {
  clearAuthReturning();
  resetAuthHops();
}

function AccountHydrator({
  userId,
  children,
  onReady,
}: {
  userId: string;
  children: ReactNode;
  onReady?: () => void;
}) {
  const { hydrateFromAccount } = useSession();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    setReady(false);
    setError("");

    const failOpen = (message: string) => {
      if (cancelled || settled) return;
      settled = true;
      authTrace("app.hydrate-fail", { message });
      setError(message);
      markClientReady();
      setReady(true);
    };

    const timer = window.setTimeout(() => {
      failOpen(`Timed out after ${Math.round(HYDRATE_TIMEOUT_MS / 1000)}s while loading this account.`);
    }, HYDRATE_TIMEOUT_MS);

    (async () => {
      const { snapshot, settings } = await loadHydratePayload({
        load: () => loadAccountHydrate(),
      });
      let next = snapshot;
      if (snapshot.projects.length === 0) {
        const legacy = readLegacyLocalStore();
        if (legacy) {
          next = await withTimeout(importAccountSnapshot({ data: legacy }), 4_000);
        }
      }
      if (cancelled || settled) return;
      settled = true;
      window.clearTimeout(timer);
      hydrateStore(next);
      bindAccountStore();
      hydrateFromAccount(settings);
      onReady?.();
      authTrace("app.hydrated", { userId });
      markClientReady();
      setError("");
      setReady(true);
    })().catch((err) => {
      window.clearTimeout(timer);
      failOpen(err instanceof Error ? err.message : "Could not load this account.");
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attempt, hydrateFromAccount, onReady, userId]);

  if (!ready) return <BootScreen label="Loading your projects…" />;
  if (error) {
    return (
      <div
        data-cb-shell="error"
        className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16"
        style={BOOT_STYLE}
      >
        <ShellReadyScript />
        <p className="text-danger">{error}</p>
        <p className="max-w-md text-center text-sm text-muted">
          Sign-in worked. Loading projects from the account database did not finish. Retry, or sign out and
          sign in again.
        </p>
        <SystemRevisionLine className="text-center" />
        <button
          type="button"
          className="min-h-11 rounded-sm px-4 font-semibold"
          style={{ background: "#d7d4cc", color: "#0c0c0d" }}
          onClick={() => {
            setError("");
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
        <button
          type="button"
          className="min-h-11 rounded-sm border border-line px-4 font-semibold"
          onClick={() => {
            hydrateStore(EMPTY_SNAPSHOT);
            bindAccountStore();
            setError("");
            onReady?.();
            setReady(true);
          }}
        >
          Open workspace anyway
        </button>
        <button
          type="button"
          className="min-h-11 rounded-sm border border-line px-4 font-semibold"
          onClick={() => {
            void signOut("/login");
          }}
        >
          Sign out
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col" data-cb-shell="app">
      <ShellReadyScript />
      {children}
    </div>
  );
}

export function AccountChip() {
  const { user, isPending } = useCurrentUserState();
  if (isPending && !user) return <div className="h-11 w-36 animate-pulse rounded-sm bg-subtle" />;
  if (!user) return null;
  return (
    <div className="max-w-56 min-w-0 [&_button]:min-h-11 [&_button]:px-2 [&_span]:truncate">
      <UserButton />
    </div>
  );
}
