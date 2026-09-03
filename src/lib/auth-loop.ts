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
export const AUTH_BROADCAST_CHANNEL = "grok-auth-popup";
export const AUTH_POPUP_WAIT_MS = 120_000;
export const GET_SESSION_WAIT_MS = 5_000;
export const OAUTH_LEAVE_FRAME_ANCESTORS =
  "frame-ancestors 'self' https://grok.com https://*.grok.com https://*.grok.me https://*.grok-sandbox.com";

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

function isViteDev(): boolean {
  try {
    return Boolean(import.meta.env && import.meta.env.DEV);
  } catch {
    return false;
  }
}

/**
 * Same-origin start path for a popup / overlay. Vite live preview serves
 * `/auth/popup`; deployed hosts use `/api/oauth-start/:id`.
 */
export function oauthPopupPath(
  providerId: string,
  input: { hostname?: string; dev?: boolean } = {},
): string {
  const hostname = (input.hostname ?? (typeof window === "undefined" ? "" : window.location.hostname)).toLowerCase();
  const dev = input.dev ?? isViteDev();
  const id = encodeURIComponent(providerId);
  if (dev || hostname.endsWith(".grok-sandbox.com")) {
    return `/auth/popup?providerId=${id}`;
  }
  return `/api/oauth-start/${id}`;
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    if (ch === '"') return "&" + "quot;";
    return "&#39;";
  });
}

export function applyOAuthLeaveHeaders(headers: Headers): void {
  headers.delete("location");
  headers.delete("x-frame-options");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-security-policy", OAUTH_LEAVE_FRAME_ANCESTORS);
  headers.set("cross-origin-resource-policy", "cross-origin");
}

/**
 * Same-origin interstitial instead of a 302 to Google/X.
 *
 * Grok preview intercepts `window.open` as an iframe overlay. A 302 to the
 * broker then loads Google inside that iframe → Chrome ERR_BLOCKED_BY_RESPONSE
 * (X-Frame-Options). This page stays on our origin. Top-level windows jump
 * immediately; framed overlays keep a `target=_blank` Continue link so Google
 * never paints in the iframe.
 */
export function renderOAuthLeaveHtml(oauthUrl: string): string {
  const payload = JSON.stringify({ url: oauthUrl }).replace(/</g, "\\u003c");
  const href = escapeHtml(oauthUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>Signing in…</title>
<style>
  html,body{margin:0;min-height:100%;background:#0b0b0c;color:#e7e5e4;
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{min-height:100vh;display:grid;place-items:center;padding:1.5rem;text-align:center}
  .box{max-width:28rem}
  h1{font-size:1.25rem;margin:0 0 .75rem;color:#f1f1ef}
  p{margin:0 0 1rem;color:#a1a1aa}
  a.btn{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 1.1rem;
    background:#d7d4cc;color:#0c0c0d;font-weight:600;text-decoration:none;border-radius:8px}
</style>
</head>
<body data-cb-oauth-leave="1">
<main>
  <div class="box">
    <h1 id="status">Signing you in…</h1>
    <p id="hint">Opening Google or X. If this stays, tap Continue.</p>
    <p><a class="btn" id="go" href="${href}" target="_blank" rel="opener">Continue with Google</a></p>
  </div>
</main>
<script type="application/json" id="cb-oauth-leave">${payload}</script>
<script>
(function () {
  var url = "";
  try {
    var el = document.getElementById("cb-oauth-leave");
    if (el && el.textContent) url = JSON.parse(el.textContent).url || "";
  } catch (e) {}
  var go = document.getElementById("go");
  if (go && url) go.setAttribute("href", url);
  var framed = false;
  try { framed = window.self !== window.top; } catch (e) { framed = true; }
  document.body.setAttribute("data-cb-oauth-leave", framed ? "framed" : "top");
  if (!framed) {
    if (url) location.replace(url);
    return;
  }
  var status = document.getElementById("status");
  var hint = document.getElementById("hint");
  if (status) status.textContent = "Continue in a new window";
  if (hint) hint.textContent = "Google blocks sign-in inside this preview. Continue opens a real window. If it stays blocked, open this preview in a new tab first, then sign in.";
})();
</script>
</body>
</html>`;
}

export function oauthLeaveResponse(oauthUrl: string, headers: Headers): Response {
  applyOAuthLeaveHeaders(headers);
  return new Response(renderOAuthLeaveHtml(oauthUrl), { status: 200, headers });
}

export function authPopupHandoffInlineScript(): string {
  return `(function () {
  var el = document.getElementById("grok-auth-popup-msg");
  var msg = { source: "${AUTH_POPUP_SOURCE}", token: null };
  try { if (el && el.textContent) msg = JSON.parse(el.textContent); } catch (e) {}
  try {
    var ch = new BroadcastChannel("${AUTH_BROADCAST_CHANNEL}");
    ch.postMessage(msg);
    ch.close();
  } catch (e) {}
  try { if (window.opener) window.opener.postMessage(msg, window.location.origin); } catch (e) {}
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, window.location.origin);
  } catch (e) {}
  try { window.close(); } catch (e) {}
})();`;
}

export function waitForAuthPopup(
  popup: Window | null,
  opts: { origin?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const origin = opts.origin ?? window.location.origin;
  const timeoutMs = opts.timeoutMs ?? AUTH_POPUP_WAIT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let closeTimer: number | undefined;
    let channel: BroadcastChannel | null = null;
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
    const onBroadcast = (event: MessageEvent) => {
      const token = tokenFromAuthPopupMessage(event.data, origin, origin);
      if (token === undefined) return;
      settle(token);
    };
    const pollTimer = window.setInterval(() => {
      if (!popup || !popup.closed) return;
      window.clearInterval(pollTimer);
      closeTimer = window.setTimeout(() => settle(null), 400);
    }, 300);
    const timeoutTimer = window.setTimeout(() => settle(null), timeoutMs);
    function cleanup() {
      window.clearInterval(pollTimer);
      window.clearTimeout(timeoutTimer);
      if (closeTimer !== undefined) window.clearTimeout(closeTimer);
      window.removeEventListener("message", onMessage);
      try {
        channel?.removeEventListener("message", onBroadcast);
        channel?.close();
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("message", onMessage);
    try {
      channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
      channel.addEventListener("message", onBroadcast);
    } catch {
      channel = null;
    }
  });
}
