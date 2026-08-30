import { createFileRoute } from "@tanstack/react-router";
import { auth } from "@/lib/auth/server";
import { finalizeAuthResponse } from "@/lib/auth-response";

function isCallback(request: Request) {
  const path = new URL(request.url).pathname;
  return request.method === "GET" && path.startsWith("/api/auth/") && path.includes("/callback");
}

async function handleAuth(request: Request): Promise<Response> {
  const started = Date.now();
  try {
    const response = await auth.handler(request);
    return await finalizeAuthResponse(request, response, started);
  } catch (err) {
    console.error(
      "[auth-hop]",
      JSON.stringify({
        t: new Date().toISOString(),
        path: new URL(request.url).pathname,
        method: request.method,
        error: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started,
      }),
    );
    if (isCallback(request)) {
      const url = new URL("/login", request.url);
      url.searchParams.set("error", "oauth");
      return finalizeAuthResponse(request, Response.redirect(url, 302), started);
    }
    throw err;
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
});
