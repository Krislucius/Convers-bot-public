import { detectProviderFromUrl, isPrivateConversationPath, isSharePath, isUnsupportedProviderPath, looksLikeLoginUrl } from "./detect.ts";
import { parseConversation } from "./parse.ts";
import { titleFromHtml } from "./providers/chatgpt.ts";
import type { AccessCheckResult, AccessStatus, ChatProvider, FetchedPage } from "./types.ts";
import { formatOpLog } from "../op-log.ts";

const LOGIN_COPY =
  /\b(log in|sign in|signin|login required|create an account|continue to chatgpt|continue to claude|continue to grok|войти|авторизац)\b/i;

const NOT_FOUND_COPY = /\b(not found|doesn't exist|does not exist|deleted|unavailable|404)\b/i;

export const ACCESS_COPY: Record<AccessStatus, string> = {
  NOT_CHECKED: "Access has not been checked yet.",
  ACCESSIBLE: "Public conversation is readable. Import available.",
  AUTH_REQUIRED:
    "The conversation exists or redirects to an authenticated page, but the bot cannot read it without account access. Use Upload or Paste instead.",
  NOT_FOUND: "The supplied conversation could not be found.",
  UNSUPPORTED: "The URL belongs to a known provider but this conversation format is not currently supported.",
  FETCH_FAILED:
    "The URL could not be fetched. This is a network or read failure, not proof that the chat is private.",
};

function result(
  partial: Omit<AccessCheckResult, "ok" | "importAllowed" | "message"> & { message?: string },
): AccessCheckResult {
  const importAllowed = partial.accessStatus === "ACCESSIBLE";
  return {
    ...partial,
    ok: partial.accessStatus !== "FETCH_FAILED",
    importAllowed,
    message: partial.message ?? ACCESS_COPY[partial.accessStatus],
  };
}

function looksLikeLoginPage(body: string, finalUrl: string): boolean {
  if (looksLikeLoginUrl(finalUrl)) return true;
  if (/type=["']password["']/i.test(body)) return true;
  const head = body.slice(0, 4000);
  return LOGIN_COPY.test(head) && !parseConversation("UNKNOWN", body).reliable;
}

function titleHint(body: string): string | null {
  return titleFromHtml(body);
}

function pageMeta(page: FetchedPage): { fetchedBytes: number; truncated: boolean } {
  return { fetchedBytes: page.body.length, truncated: Boolean(page.truncated) };
}

export function accessCheckException(url: string, error: unknown): AccessCheckResult {
  const lastError = error instanceof Error ? error.message : "Access check failed.";
  const network = /failed to fetch|networkerror|load failed|aborted|timeout|network request failed/i.test(lastError);
  const provider = detectProviderFromUrl(url);
  return result({
    accessStatus: "FETCH_FAILED",
    provider,
    requestedUrl: url,
    finalUrl: url,
    httpStatus: null,
    titleHint: null,
    lastError,
    detectedShare: isSharePath(provider, url),
    fetchedBytes: 0,
    truncated: false,
    message: network
      ? "The access check request failed before the chat page could be read. This is not a login wall. Retry Check Access, or import with Upload / Paste."
      : lastError,
  });
}

export function formatAccessLog(resultValue: AccessCheckResult): string {
  return formatOpLog(
    "check_url",
    {
      accessStatus: resultValue.accessStatus,
      provider: resultValue.provider,
      requestedUrl: resultValue.requestedUrl,
      finalUrl: resultValue.finalUrl,
      httpStatus: resultValue.httpStatus,
      titleHint: resultValue.titleHint,
      importAllowed: resultValue.importAllowed,
      detectedShare: resultValue.detectedShare,
      fetchedBytes: resultValue.fetchedBytes ?? null,
      truncated: resultValue.truncated ?? null,
      lastError: resultValue.lastError,
      message: resultValue.message,
    },
    resultValue.accessStatus === "ACCESSIBLE",
  );
}

export function evaluateAccess(input: {
  requestedUrl: string;
  provider: ChatProvider;
  page: FetchedPage;
}): AccessCheckResult {
  const { requestedUrl, page } = input;
  const provider = input.provider === "UNKNOWN" ? detectProviderFromUrl(requestedUrl) : input.provider;
  const finalUrl = page.finalUrl || requestedUrl;
  const meta = pageMeta(page);

  if (page.error && !page.status) {
    const network = /failed to fetch|networkerror|load failed|timeout/i.test(page.error);
    return result({
      accessStatus: "FETCH_FAILED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: null,
      titleHint: null,
      lastError: page.error,
      detectedShare: isSharePath(provider, requestedUrl),
      ...meta,
      message: network
        ? `${ACCESS_COPY.FETCH_FAILED} ${page.error}`
        : page.error,
    });
  }

  if (page.status === 401 || page.status === 403) {
    return result({
      accessStatus: "AUTH_REQUIRED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: `HTTP ${page.status}`,
      detectedShare: isSharePath(provider, requestedUrl),
      ...meta,
    });
  }

  if (page.status === 404 || page.status === 410) {
    return result({
      accessStatus: "NOT_FOUND",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: null,
      lastError: `HTTP ${page.status}`,
      detectedShare: isSharePath(provider, requestedUrl),
      ...meta,
    });
  }

  if (page.status >= 500 || page.status === 0) {
    return result({
      accessStatus: "FETCH_FAILED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status || null,
      titleHint: null,
      lastError: page.error ?? `HTTP ${page.status}`,
      detectedShare: false,
      ...meta,
    });
  }

  const payload = parseConversation(provider, page.body);
  const detectedShare = payload.reliable || isSharePath(provider, requestedUrl) || isSharePath(provider, finalUrl);

  if (payload.reliable) {
    return result({
      accessStatus: "ACCESSIBLE",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: payload.title ?? titleHint(page.body),
      lastError: null,
      detectedShare: true,
      ...meta,
    });
  }

  if (looksLikeLoginUrl(finalUrl) || isPrivateConversationPath(provider, requestedUrl) || isPrivateConversationPath(provider, finalUrl)) {
    return result({
      accessStatus: "AUTH_REQUIRED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: null,
      detectedShare,
      ...meta,
    });
  }

  if (looksLikeLoginPage(page.body, finalUrl)) {
    return result({
      accessStatus: "AUTH_REQUIRED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: null,
      detectedShare,
      ...meta,
    });
  }

  if (NOT_FOUND_COPY.test(page.body.slice(0, 2000)) && isSharePath(provider, requestedUrl)) {
    return result({
      accessStatus: "NOT_FOUND",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: null,
      detectedShare: true,
      ...meta,
    });
  }

  if (isUnsupportedProviderPath(provider, requestedUrl) || isUnsupportedProviderPath(provider, finalUrl)) {
    return result({
      accessStatus: "UNSUPPORTED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: null,
      detectedShare: false,
      ...meta,
    });
  }

  if (provider !== "UNKNOWN" && isSharePath(provider, requestedUrl) && !payload.reliable) {
    return result({
      accessStatus: "UNSUPPORTED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: page.truncated
        ? "The share page downloaded but was truncated before a conversation payload was found."
        : "The page loaded but no conversation payload was found. A landing page is not an import.",
      detectedShare: true,
      ...meta,
      message: page.truncated
        ? "The public share downloaded, but the conversation payload was cut off. Retry Check Access, or use Upload / Paste."
        : ACCESS_COPY.UNSUPPORTED,
    });
  }

  const textLength = page.body.replace(/<[^>]+>/g, " ").trim().length;
  if (provider === "UNKNOWN" && page.status >= 200 && page.status < 300 && textLength > 400 && !looksLikeLoginPage(page.body, finalUrl)) {
    return result({
      accessStatus: "ACCESSIBLE",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: null,
      detectedShare: false,
      ...meta,
    });
  }

  if (provider !== "UNKNOWN") {
    return result({
      accessStatus: "UNSUPPORTED",
      provider,
      requestedUrl,
      finalUrl,
      httpStatus: page.status,
      titleHint: titleHint(page.body),
      lastError: "No readable conversation was found at this URL.",
      detectedShare,
      ...meta,
    });
  }

  return result({
    accessStatus: "UNSUPPORTED",
    provider,
    requestedUrl,
    finalUrl,
    httpStatus: page.status,
    titleHint: titleHint(page.body),
    lastError: "This URL is not a supported conversation format.",
    detectedShare: false,
    ...meta,
  });
}
