import { createRootRoute, HeadContent, Outlet, Scripts, useRouterState } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AccountChip, SignedInApp } from "@/components/account-shell";
import { CouncilChrome } from "@/components/council-chrome";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { AuthProvider } from "@/lib/auth/provider";
import { resolveRootSessionUser, bakeSessionUserScript, type SessionUser } from "@/lib/auth/session-bootstrap";
import { SessionProvider } from "@/lib/council/session";
import { BOOT_WATCHDOG_INLINE } from "@/lib/boot-watchdog";
import appCss from "../styles.css?url";

const APP_NAME = "Conversation Bot";

const CRITICAL_CSS =
  "html,body{background:#0c0c0d;color:#f1f1ef;margin:0;min-height:100%}";

const SESSION_COOKIE_RE = /(?:__Host-)?grok-auth\.session_token=/;

const fetchSessionUser = createServerFn({ method: "POST" }).handler(async (): Promise<SessionUser> => {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest();
    const cookie = request?.headers.get("cookie") ?? "";
    const started = Date.now();
    if (!SESSION_COOKIE_RE.test(cookie)) {
      console.log("[auth-ssr]", JSON.stringify({ hasCookie: false, hasUser: false, ms: Date.now() - started }));
      return null;
    }
    const { getSessionUser } = await import("@/lib/auth/verify.server");
    const user = await getSessionUser();
    console.log(
      "[auth-ssr]",
      JSON.stringify({ hasCookie: true, hasUser: Boolean(user), ms: Date.now() - started }),
    );
    return user ? { id: user.id, email: user.email } : null;
  } catch (err) {
    console.error(
      "[auth-ssr]",
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
    );
    return null;
  }
});

function isPublicPath(pathname: string) {
  return pathname === "/login" || pathname.startsWith("/login/") || pathname === "/signed-in";
}

export const Route = createRootRoute({
  beforeLoad: async ({ context }): Promise<{ sessionUser: SessionUser }> => {
    const previous = (context as { sessionUser?: SessionUser }).sessionUser ?? null;
    const sessionUser = await resolveRootSessionUser({
      isClient: typeof window !== "undefined",
      previous,
      fetchUser: fetchSessionUser,
    });
    return { sessionUser };
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "theme-color", content: "#0c0c0d" },
      {
        name: "description",
        content: "GPT architect, Grok adversary, and Claude formalist review one task.",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/__grok/icon-180.png" },
    ],
  }),
  component: () => (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <style dangerouslySetInnerHTML={{ __html: CRITICAL_CSS }} />
      </head>
      <body
        className="flex min-h-dvh flex-col bg-bg text-fg antialiased"
        style={{ background: "#0c0c0d", color: "#f1f1ef" }}
        suppressHydrationWarning
      >
        <PreviewHostBridge />
        <AuthProvider>
          <RootBody />
        </AuthProvider>
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: BOOT_WATCHDOG_INLINE }} />
        <Scripts />
      </body>
    </html>
  ),
});

function RootBody() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const sessionUser = Route.useRouteContext({ select: (ctx) => ctx.sessionUser }) ?? null;
  return (
    <SessionProvider>
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: bakeSessionUserScript(sessionUser) }} />
      {isPublicPath(pathname) ? (
        <Outlet />
      ) : (
        <SignedInApp sessionUser={sessionUser}>
          <CouncilChrome account={<AccountChip />} />
          <div className="flex flex-1 flex-col">
            <Outlet />
          </div>
          <footer className="border-t border-line px-6 py-4 text-xs text-faint">
            Conversation Bot · model output is untrusted text · no shell, no repo writes
          </footer>
        </SignedInApp>
      )}
    </SessionProvider>
  );
}
