import { SESSION_WAIT_MS } from "../auth-loop.ts";

export const SSR_SESSION_MS = 4_000;

export type SessionUser = { id: string; email: string | null } | null;

export const BAKED_SESSION_FLAG = "__CB_SSR_SESSION";

export function readBakedSessionUser(): SessionUser {
  if (typeof window === "undefined") return null;
  try {
    const baked = (window as Window & { [BAKED_SESSION_FLAG]?: unknown })[BAKED_SESSION_FLAG];
    if (!baked || typeof baked !== "object") return null;
    const id = (baked as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) return null;
    const email = (baked as { email?: unknown }).email;
    return { id, email: typeof email === "string" ? email : null };
  } catch {
    return null;
  }
}

export function bakeSessionUserScript(user: SessionUser): string {
  const payload = JSON.stringify(user).replace(/</g, "\\u003c");
  return `window.${BAKED_SESSION_FLAG}=${payload};`;
}

export type AuthBootstrapStatus = "RESOLVING" | "READY" | "ERROR";

export type ClientShell = "guest" | "app" | "boot" | "error" | "none";

function delay(ms: number): { promise: Promise<null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Root beforeLoad session resolution.
 *
 * The client must never await the SSR RPC — `useSession()` already hits
 * `/api/auth/get-session`. A hanging createServerFn here stalls the whole
 * router, so React never paints a shell and the boot watchdog fires.
 */
export async function resolveRootSessionUser(input: {
  isClient: boolean;
  previous: SessionUser;
  fetchUser: () => Promise<SessionUser>;
  timeoutMs?: number;
}): Promise<SessionUser> {
  if (input.isClient) return input.previous ?? readBakedSessionUser();
  const timeoutMs = input.timeoutMs ?? SSR_SESSION_MS;
  const timeout = delay(timeoutMs);
  try {
    const result = await Promise.race([input.fetchUser(), timeout.promise]);
    return result ?? input.previous ?? null;
  } catch {
    return input.previous ?? null;
  } finally {
    timeout.cancel();
  }
}

/** `useSession().isPending` must not last forever. */
export function boundAuthPending(input: {
  isPending: boolean;
  elapsedMs: number;
  failed?: boolean;
  limitMs?: number;
}): boolean {
  if (input.failed) return false;
  if (!input.isPending) return false;
  return input.elapsedMs < (input.limitMs ?? SESSION_WAIT_MS);
}

/**
 * Guest UI is READY even while the client session fetch is in flight.
 * Authenticated hydrate is RESOLVING until snapshot load finishes or errors.
 */
export function authBootstrapState(input: {
  user: { id: string } | null;
  sessionUser: { id: string } | null;
  isPending: boolean;
  elapsedMs: number;
  hydrateReady?: boolean;
  hydrateError?: string | null;
  failedAuth?: boolean;
}): { status: AuthBootstrapStatus; shell: ClientShell; isPending: boolean } {
  const isPending = boundAuthPending({
    isPending: input.isPending,
    elapsedMs: input.elapsedMs,
    failed: input.failedAuth,
  });
  if (input.hydrateError) {
    return { status: "ERROR", shell: "error", isPending: false };
  }
  if (input.user || input.sessionUser) {
    if (input.hydrateReady) return { status: "READY", shell: "app", isPending: false };
    return { status: "RESOLVING", shell: "boot", isPending };
  }
  return { status: "READY", shell: "guest", isPending: false };
}

/** Any React-mounted shell means the hashed client bundle started. */
export function shouldMarkClientReady(shell: ClientShell): boolean {
  return shell !== "none";
}

export function clientExceptionOutcome(): { status: "ERROR"; shell: "error"; markReady: true } {
  return { status: "ERROR", shell: "error", markReady: true };
}
