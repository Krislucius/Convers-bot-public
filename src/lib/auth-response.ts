export const AUTH_DEBUG_COOKIE = "grok-auth.debug";
const BEARER_KEY = "grok-auth.bearer-token";

export type AuthHopReport = {
  t: string;
  method: string;
  path: string;
  status: number;
  location: string | null;
  inboundCookieNames: string[];
  outboundCookieNames: string[];
  hasSessionIn: boolean;
  hasSessionOut: boolean;
  handedBearer: boolean;
  bounce: "confirm" | "leave" | "next" | null;
  host: string | null;
  proto: string | null;
  ms: number;
};

export type AuthBounceMode = "confirm" | "leave" | "next";

function isSessionCookie(name: string): boolean {
  return /session_token/i.test(name);
}

export function listCookieNames(header: string): string[] {
  if (!header) return [];
  const names: string[] = [];
  for (const part of header.split(";")) {
    const name = part.trim().split("=")[0]?.trim();
    if (name) names.push(name);
  }
  return names;
}

export function cookieNameFromSetCookie(raw: string): string | null {
  const eq = raw.indexOf("=");
  if (eq <= 0) return null;
  const name = raw.slice(0, eq).trim();
  return name || null;
}

export function setCookieNames(headers: Headers): string[] {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  return raw.map((cookie) => cookieNameFromSetCookie(cookie)).filter((name): name is string => Boolean(name));
}

export function mergeSetCookies(primary: string[], extra: string[]): string[] {
  const byName = new Map<string, string>();
  for (const cookie of extra) {
    const name = cookieNameFromSetCookie(cookie);
    if (name) byName.set(name, cookie);
  }
  for (const cookie of primary) {
    const name = cookieNameFromSetCookie(cookie);
    if (name) byName.set(name, cookie);
  }
  return [...byName.values()];
}

export function sessionTokenFromSetCookie(rawCookies: string[]): string | null {
  for (const raw of rawCookies) {
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const name = raw.slice(0, eq).trim();
    if (!isSessionCookie(name)) continue;
    let value = raw.slice(eq + 1);
    const semi = value.indexOf(";");
    if (semi >= 0) value = value.slice(0, semi);
    value = value.trim();
    if (!value) continue;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function sessionTokenFromAuthHeaders(headers: Headers, rawCookies: string[]): string | null {
  const handed = headers.get("set-auth-token")?.trim();
  if (handed) {
    try {
      return decodeURIComponent(handed);
    } catch {
      return handed;
    }
  }
  return sessionTokenFromSetCookie(rawCookies);
}

function pathOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value, "https://local.invalid").pathname;
  } catch {
    return value.split("?")[0] ?? null;
  }
}

function publicHost(request: Request): { host: string | null; proto: string } {
  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  return { host, proto };
}

function debugCookieLine(report: AuthHopReport, request: Request): string {
  const { host, proto } = publicHost(request);
  const secure =
    proto === "https" || host === "localhost" || host?.startsWith("localhost:") || host?.startsWith("127.0.0.1");
  const compact = {
    t: report.t,
    path: report.path,
    status: report.status,
    location: report.location,
    in: report.inboundCookieNames,
    out: report.outboundCookieNames,
    sessionIn: report.hasSessionIn,
    sessionOut: report.hasSessionOut,
    handedBearer: report.handedBearer,
    bounce: report.bounce,
    host: report.host,
    ms: report.ms,
  };
  const parts = [
    `${AUTH_DEBUG_COOKIE}=${encodeURIComponent(JSON.stringify(compact))}`,
    "Path=/",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildHopReport(input: {
  request: Request;
  response: Response;
  ms: number;
  extraOutbound?: string[];
  handedBearer?: boolean;
  bounce?: AuthBounceMode | null;
}): AuthHopReport {
  const url = new URL(input.request.url);
  const { host, proto } = publicHost(input.request);
  const inbound = listCookieNames(input.request.headers.get("cookie") ?? "");
  const outbound = [...setCookieNames(input.response.headers), ...(input.extraOutbound ?? [])];
  return {
    t: new Date().toISOString(),
    method: input.request.method,
    path: url.pathname,
    status: input.response.status,
    location: pathOnly(input.response.headers.get("location")),
    inboundCookieNames: inbound,
    outboundCookieNames: outbound,
    hasSessionIn: inbound.some(isSessionCookie),
    hasSessionOut: outbound.some(isSessionCookie),
    handedBearer: Boolean(input.handedBearer),
    bounce: input.bounce ?? null,
    host,
    proto,
    ms: input.ms,
  };
}

export function isAuthCallbackPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth/") && pathname.includes("/callback");
}

export function isOAuthStartPath(pathname: string): boolean {
  return pathname.startsWith("/api/oauth-start/");
}

export function safeNextPath(location: string | null, hasSession: boolean): string {
  if (hasSession) return "/";
  if (!location) return "/login";
  try {
    const url = new URL(location, "https://local.invalid");
    const path = url.pathname || "/login";
    const search = url.search || "";
    if (path === "/login" || path.startsWith("/login/")) return `${path}${search}`;
    if (path === "/signed-in") return "/signed-in";
    if (path === "/") return "/";
    if (path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/api/")) return `${path}${search}`;
  } catch {
    const path = location.split("?")[0] ?? "/login";
    if (path === "/login" || path.startsWith("/login/")) return location.startsWith("/") ? location : "/login";
  }
  return "/login";
}

export function isExternalUrl(location: string, requestUrl: string): boolean {
  try {
    return new URL(location).origin !== new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

export function safeLeaveUrl(location: string | null, requestUrl: string): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, requestUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
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

function bounceCopy(mode: AuthBounceMode): { title: string; hint: string; button: string } {
  if (mode === "leave") {
    return {
      title: "Continue to sign-in…",
      hint: "Opening Google or X in this window. If this stays, tap Continue.",
      button: "Continue",
    };
  }
  if (mode === "confirm") {
    return {
      title: "Opening your projects…",
      hint: "Sign-in finished. If this stays, tap Continue.",
      button: "Continue",
    };
  }
  return {
    title: "Sign-in did not finish",
    hint: "Expand the JSON report and copy it. Then try Sign in again.",
    button: "Sign in",
  };
}

function authBounceHtml(
  headers: Headers,
  hop: AuthHopReport,
  mode: AuthBounceMode,
  nextPath: string,
  sessionToken: string | null,
): Response {
  const copy = bounceCopy(mode);
  const report = JSON.stringify(hop, null, 2);
  const payload = JSON.stringify({
    token: sessionToken,
    next: nextPath,
    bearerKey: BEARER_KEY,
    mode,
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <meta name="referrer" content="no-referrer"/>
  <meta http-equiv="refresh" content="1;url=${escapeHtml(nextPath)}"/>
  <title>Conversation Bot</title>
  <style>
    html,body{margin:0;min-height:100%;background:#0c0c0d;color:#f1f1ef;font-family:"Segoe UI",system-ui,sans-serif}
    main{max-width:42rem;margin:0 auto;padding:2.5rem 1rem 4rem}
    h1{font-family:Palatino,"Palatino Linotype",Georgia,serif;font-size:1.8rem;margin:0 0 0.75rem}
    p{color:#9a9a94;line-height:1.5}
    a.btn{display:inline-flex;min-height:44px;align-items:center;justify-content:center;padding:0 1rem;background:#d7d4cc;color:#0c0c0d;font-weight:600;text-decoration:none;border-radius:8px}
    details{margin-top:1.5rem;border:1px solid color-mix(in srgb,#f1f1ef 12%,transparent);border-radius:12px;background:#141416}
    summary{min-height:44px;cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;font-weight:600}
    summary::-webkit-details-marker{display:none}
    pre{margin:0;padding:1rem;border-top:1px solid color-mix(in srgb,#f1f1ef 12%,transparent);max-height:20rem;overflow:auto;white-space:pre-wrap;color:#9a9a94;font:0.85rem/1.4 ui-monospace,Menlo,monospace}
  </style>
</head>
<body>
  <main>
    <h1 id="title">${escapeHtml(copy.title)}</h1>
    <p id="hint">${escapeHtml(copy.hint)}</p>
    <p><a class="btn" id="go" href="${escapeHtml(nextPath)}">${escapeHtml(copy.button)}</a></p>
    <details${mode === "next" ? " open" : ""}>
      <summary><span>Sign-in report (JSON)</span><span>Expand</span></summary>
      <pre id="report">${escapeHtml(report)}</pre>
    </details>
  </main>
  <script type="application/json" id="grok-auth-handoff">${payload}</script>
  <script>
  (function () {
    var data = { token: null, next: "/login", bearerKey: "${BEARER_KEY}", mode: "next" };
    try {
      var el = document.getElementById("grok-auth-handoff");
      if (el && el.textContent) data = JSON.parse(el.textContent);
    } catch (e) {}
    if (data.token && data.bearerKey) {
      try { sessionStorage.setItem(data.bearerKey, data.token); } catch (e) {}
    }
    window.setTimeout(function () {
      location.replace(data.next || "/");
    }, 50);
  })();
  </script>
</body>
</html>`;

  const nextHeaders = new Headers(headers);
  nextHeaders.delete("location");
  nextHeaders.set("content-type", "text/html; charset=utf-8");
  nextHeaders.set("cache-control", "no-store");
  nextHeaders.set("referrer-policy", "no-referrer");
  return new Response(html, { status: 200, headers: nextHeaders });
}

async function eventStoreCookies(): Promise<string[]> {
  try {
    const mod = await import("@tanstack/react-start/server");
    const headers = mod.getResponseHeaders?.() as Headers | undefined;
    if (headers && typeof headers.getSetCookie === "function") {
      return headers.getSetCookie();
    }
    const joined = headers?.get("set-cookie");
    return joined ? [joined] : [];
  } catch {
    return [];
  }
}

export async function finalizeAuthResponse(
  request: Request,
  response: Response,
  started: number,
): Promise<Response> {
  const responseCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const rawCookies = mergeSetCookies(responseCookies, await eventStoreCookies());
  const sessionToken = sessionTokenFromAuthHeaders(response.headers, rawCookies);

  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    headers.set(key, value);
  });
  for (const cookie of rawCookies) headers.append("set-cookie", cookie);

  const url = new URL(request.url);
  const isRedirect = response.status >= 300 && response.status < 400;
  const locationHeader = response.headers.get("location");
  const callback = isAuthCallbackPath(url.pathname);
  const oauthStart = isOAuthStartPath(url.pathname);
  const leaveUrl = isRedirect ? safeLeaveUrl(locationHeader, request.url) : null;
  const leaveExternal = Boolean(leaveUrl && isExternalUrl(leaveUrl, request.url));

  let bounce: AuthBounceMode | null = null;
  if (callback && isRedirect) {
    bounce = sessionToken ? "confirm" : "next";
  } else if (oauthStart && isRedirect) {
    bounce = leaveExternal ? "leave" : "next";
  }

  const hop = buildHopReport({
    request,
    response: new Response(null, { status: response.status, headers }),
    ms: Date.now() - started,
    extraOutbound: [AUTH_DEBUG_COOKIE],
    handedBearer: Boolean(sessionToken),
    bounce,
  });
  headers.append("set-cookie", debugCookieLine(hop, request));
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  console.log("[auth-hop]", JSON.stringify(hop));

  if (bounce === "confirm") {
    return authBounceHtml(headers, hop, "confirm", "/", sessionToken);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
