import type { ChatProvider } from "./types.ts";

function hostname(url: string): { host: string; path: string; href: string } | null {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname.replace(/^www\./, "").toLowerCase(),
      path: parsed.pathname.toLowerCase(),
      href: parsed.href,
    };
  } catch {
    return null;
  }
}

export function detectProviderFromUrl(url: string): ChatProvider {
  const parsed = hostname(url);
  if (!parsed) return "UNKNOWN";
  const { host, path } = parsed;
  if (host === "chatgpt.com" || host === "chat.openai.com" || host === "openai.com") return "CHATGPT";
  if (host === "claude.ai" || host === "anthropic.com") return "CLAUDE";
  if (host === "grok.com" || host === "grok.x.ai") {
    if (path.includes("grok-app-builder") || path.includes("app-builder")) return "GROK_BUILD";
    return "GROK";
  }
  if (host === "x.com" || host === "twitter.com") {
    if (path.includes("grok")) return "GROK";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

export function isPrivateConversationPath(provider: ChatProvider, url: string): boolean {
  const parsed = hostname(url);
  if (!parsed) return false;
  const { path } = parsed;
  if (provider === "CHATGPT") return path.startsWith("/c/") || path.startsWith("/gpts/");
  if (provider === "CLAUDE") return path.startsWith("/chat/") || path.startsWith("/project/");
  if (provider === "GROK" || provider === "GROK_BUILD") {
    return path.startsWith("/chat") || path.includes("/c/");
  }
  return false;
}

export function isSharePath(provider: ChatProvider, url: string): boolean {
  const parsed = hostname(url);
  if (!parsed) return false;
  const { path } = parsed;
  if (provider === "CHATGPT") return path.startsWith("/share/");
  if (provider === "CLAUDE") return path.startsWith("/share/");
  if (provider === "GROK" || provider === "GROK_BUILD") return path.startsWith("/share");
  return false;
}

export function isUnsupportedProviderPath(provider: ChatProvider, url: string): boolean {
  const parsed = hostname(url);
  if (!parsed) return false;
  const { path } = parsed;
  if (path === "/" || path === "") return true;
  if (provider === "CHATGPT") {
    return (
      path.startsWith("/pricing") ||
      path.startsWith("/auth") ||
      path.startsWith("/api") ||
      path.startsWith("/business") ||
      path.startsWith("/codex")
    );
  }
  if (provider === "CLAUDE") {
    return path.startsWith("/login") || path.startsWith("/pricing") || path.startsWith("/api");
  }
  if (provider === "GROK" || provider === "GROK_BUILD") {
    return path.startsWith("/login") || path === "/home";
  }
  return false;
}

export function looksLikeLoginUrl(url: string): boolean {
  const parsed = hostname(url);
  if (!parsed) return false;
  const { path } = parsed;
  return (
    path.includes("/login") ||
    path.includes("/log-in") ||
    path.includes("/signin") ||
    path.includes("/sign-in") ||
    path.includes("/auth") ||
    path.includes("/account/login")
  );
}
