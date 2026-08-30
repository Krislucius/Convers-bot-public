import { createFileRoute } from "@tanstack/react-router";
import { GROK_PROVIDERS } from "@/lib/auth/providers";
import { finalizeAuthResponse } from "@/lib/auth-response";

const ALLOWED = new Set(GROK_PROVIDERS.map((provider) => provider.providerId));
const START_TIMEOUT_MS = 8000;

function headerHost(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return value.split("/")[0] || null;
  }
}

function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "") || "https";
  const hosts = [
    headerHost(request.headers.get("origin")),
    headerHost(request.headers.get("referer")),
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim(),
    request.headers.get("host")?.split(",")[0]?.trim(),
    url.host,
  ].filter((host): host is string => Boolean(host));
  const grok = hosts.find((host) => /\.grok\.me$/i.test(host) || /\.grok-sandbox\.com$/i.test(host));
  const local = hosts.find((host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host));
  const host = grok || local || hosts[0] || url.host;
  return `${proto}://${host}`;
}

function authOrigin(request: Request): string {
  const configured = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  if (configured) {
    try {
      const host = new URL(configured).host;
      if (/\.grok\.me$/i.test(host) || /localhost|127\.0\.0\.1/.test(host)) return configured;
    } catch {
      /* ignore */
    }
  }
  return publicOrigin(request);
}

function loginError(request: Request, code: string): Response {
  const url = new URL("/login", authOrigin(request));
  url.searchParams.set("error", code);
  return Response.redirect(url, 302);
}

async function startOAuth(request: Request, providerId: string): Promise<Response> {
  if (!ALLOWED.has(providerId)) return loginError(request, "unknown-provider");

  const { auth } = await import("@/lib/auth/server");
  const origin = authOrigin(request);
  const apiRes = await auth.api.signInWithOAuth2({
    body: {
      providerId,
      callbackURL: `${origin}/`,
      errorCallbackURL: `${origin}/login?error=oauth`,
    },
    headers: request.headers,
    asResponse: true,
  });

  if (!apiRes.ok) return loginError(request, "oauth-init");

  const body = (await apiRes.json().catch(() => null)) as { url?: string } | null;
  const location = body?.url?.trim();
  if (!location) return loginError(request, "oauth-url");

  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of apiRes.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

export const Route = createFileRoute("/api/oauth-start/$providerId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const started = Date.now();
        const fromParams = params.providerId?.trim() ?? "";
        const fromPath = new URL(request.url).pathname.split("/").pop()?.trim() ?? "";
        const providerId = fromParams || fromPath;
        try {
          const response = await Promise.race([
            startOAuth(request, providerId),
            new Promise<Response>((resolve) => {
              setTimeout(() => resolve(loginError(request, "signin-timeout")), START_TIMEOUT_MS);
            }),
          ]);
          return await finalizeAuthResponse(request, response, started);
        } catch (err) {
          console.error(
            "[auth-hop]",
            JSON.stringify({
              t: new Date().toISOString(),
              path: "/api/oauth-start",
              providerId,
              error: err instanceof Error ? err.message : String(err),
              ms: Date.now() - started,
            }),
          );
          return finalizeAuthResponse(request, loginError(request, "signin-failed"), started);
        }
      },
    },
  },
});
