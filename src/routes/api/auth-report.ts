import { createFileRoute } from "@tanstack/react-router";
import { listCookieNames } from "@/lib/auth-response";

const PROBE_MS = 2000;

export const Route = createFileRoute("/api/auth-report")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const started = Date.now();
        const url = new URL(request.url);
        const cookieHeader = request.headers.get("cookie") ?? "";
        const cookieNames = listCookieNames(cookieHeader);
        const host =
          request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
          request.headers.get("host") ||
          url.host;
        const proto =
          request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
          url.protocol.replace(":", "");

        let sessionPresent = false;
        let hasUserId = false;
        let timedOut = false;
        let sessionError: string | null = null;

        try {
          const { getSessionUser } = await import("@/lib/auth/verify.server");
          const inboundBearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
          const user = await Promise.race([
            getSessionUser(inboundBearer || undefined),
            new Promise<null>((resolve) => {
              setTimeout(() => {
                timedOut = true;
                resolve(null);
              }, PROBE_MS);
            }),
          ]);
          sessionPresent = Boolean(user);
          hasUserId = Boolean(user?.id);
          if (!user && timedOut) sessionError = "timeout";
        } catch (err) {
          sessionError = err instanceof Error ? err.message : String(err);
        }

        const report = {
          title: "Conversation Bot · sign-in report",
          t: new Date().toISOString(),
          path: url.pathname,
          method: request.method,
          host,
          proto,
          cookieNames,
          hasSessionCookie: cookieNames.some((name) => /session_token/i.test(name)),
          hasDebugCookie: cookieNames.includes("grok-auth.debug"),
          sessionPresent,
          hasUserId,
          timedOut,
          sessionError,
          betterAuthUrlSet: Boolean(process.env.BETTER_AUTH_URL?.trim()),
          databaseUrlSet: Boolean(process.env.DATABASE_URL?.trim()),
          ms: Date.now() - started,
        };
        console.log("[auth-report]", JSON.stringify(report));
        return Response.json(report, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
