const HOPS_KEY = "grok-auth.hops";
const TOKEN_KEY = "grok-auth.bearer-token";
const RETURNING_KEY = "grok-auth.returning";
const LANDING_KEY = "grok-auth.landing";
export const MAX_AUTO_LANDS = 1;
export const SESSION_WAIT_MS = 5000;

export function readAuthHops(): number {
  if (typeof window === "undefined") return 0;
  try {
    const n = Number(window.sessionStorage.getItem(HOPS_KEY) || "0");
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function bumpAuthHops(): number {
  const next = readAuthHops() + 1;
  if (typeof window === "undefined") return next;
  try {
    window.sessionStorage.setItem(HOPS_KEY, String(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function resetAuthHops(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(HOPS_KEY);
    window.sessionStorage.removeItem(LANDING_KEY);
  } catch {
    /* ignore */
  }
}

export function shouldAutoLand(): boolean {
  return readAuthHops() < MAX_AUTO_LANDS;
}

export function beginAutoLand(): boolean {
  if (typeof window === "undefined") return shouldAutoLand();
  try {
    if (window.sessionStorage.getItem(LANDING_KEY) === "1") return true;
    if (!shouldAutoLand()) return false;
    window.sessionStorage.setItem(LANDING_KEY, "1");
    bumpAuthHops();
    return true;
  } catch {
    return shouldAutoLand();
  }
}

export function markAuthReturning() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RETURNING_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearAuthReturning() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RETURNING_KEY);
  } catch {
    /* ignore */
  }
}

export function isAuthReturning() {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(RETURNING_KEY) === "1";
  } catch {
    return false;
  }
}

export function extractSessionToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  if (typeof data.token === "string" && data.token.trim()) return data.token.trim();
  const session = data.session && typeof data.session === "object" ? (data.session as Record<string, unknown>) : null;
  if (session && typeof session.token === "string" && session.token.trim()) return session.token.trim();
  if (typeof root.token === "string" && root.token.trim()) return root.token.trim();
  return null;
}

export function captureSessionToken(payload: unknown): boolean {
  const token = extractSessionToken(payload);
  if (!token || typeof window === "undefined") return false;
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false;
  }
}

/** First paint / SSR: never trap a guest on a JS-dependent boot pulse. */
export type AccountShellKind = "hydrator" | "guest";

export function accountShellKind(input: {
  sessionUser: { id: string } | null;
  user: { id: string } | null;
}): AccountShellKind {
  if (input.user || input.sessionUser) return "hydrator";
  return "guest";
}
