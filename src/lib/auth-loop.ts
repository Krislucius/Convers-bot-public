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

export const AUTH_POPUP_SOURCE = "grok-auth-popup";
export const AUTH_POPUP_WAIT_MS = 120_000;
export const GET_SESSION_WAIT_MS = 5_000;

export function isAuthFramed(win?: { self: unknown; top: unknown } | null): boolean {
  const target = win ?? (typeof window === "undefined" ? null : window);
  if (!target) return false;
  try {
    return target.self !== target.top;
  } catch {
    return true;
  }
}

/** Sandbox iframe and any framed production preview must not navigate this window to the broker. */
export function shouldPopupOAuth(input: { hostname?: string; framed?: boolean } = {}): boolean {
  const hostname = input.hostname ?? (typeof window === "undefined" ? "" : window.location.hostname);
  const framed = input.framed ?? isAuthFramed();
  return framed || hostname.endsWith(".grok-sandbox.com");
}

export type AuthPopupMessage = { source: string; token?: string | null; error?: string };

/** `undefined` = ignore; `null` = explicit failure; string = session token. */
export function tokenFromAuthPopupMessage(
  data: unknown,
  expectedOrigin: string,
  eventOrigin: string,
): string | null | undefined {
  if (eventOrigin !== expectedOrigin) return undefined;
  if (!data || typeof data !== "object") return undefined;
  const msg = data as AuthPopupMessage;
  if (msg.source !== AUTH_POPUP_SOURCE) return undefined;
  if (typeof msg.token === "string" && msg.token.trim()) return msg.token.trim();
  return null;
}

export function withDeadline<T>(promise: Promise<T>, ms: number, message = "Timed out"): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function waitForAuthPopup(
  popup: Window,
  opts: { origin?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const origin = opts.origin ?? window.location.origin;
  const timeoutMs = opts.timeoutMs ?? AUTH_POPUP_WAIT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let closeTimer: number | undefined;
    const settle = (token: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(token);
    };
    const onMessage = (event: MessageEvent) => {
      const token = tokenFromAuthPopupMessage(event.data, origin, event.origin);
      if (token === undefined) return;
      settle(token);
    };
    const pollTimer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(pollTimer);
      closeTimer = window.setTimeout(() => settle(null), 400);
    }, 300);
    const timeoutTimer = window.setTimeout(() => settle(null), timeoutMs);
    function cleanup() {
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
    }
    window.addEventListener("message", onMessage);
  });
}

