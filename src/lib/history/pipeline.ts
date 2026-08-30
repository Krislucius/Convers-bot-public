import { accessCheckException, evaluateAccess } from "./access.ts";
import { detectProviderFromUrl } from "./detect.ts";
import { parseConversation } from "./parse.ts";
import type { AccessCheckResult, ChatProvider, UrlFetcher } from "./types.ts";
import { validateChatUrl } from "./url.ts";

export function resolveProvider(url: string, provider: ChatProvider | "AUTO"): ChatProvider {
  if (provider && provider !== "AUTO") return provider;
  return detectProviderFromUrl(url);
}

function invalidUrlResult(url: string, provider: ChatProvider | "AUTO", error: string): AccessCheckResult {
  return {
    ok: false,
    importAllowed: false,
    accessStatus: "FETCH_FAILED",
    provider: provider === "AUTO" ? "UNKNOWN" : provider,
    requestedUrl: url,
    finalUrl: url,
    httpStatus: null,
    titleHint: null,
    message: error,
    lastError: error,
    detectedShare: false,
    fetchedBytes: 0,
    truncated: false,
  };
}

export async function checkUrlAccess(
  url: string,
  provider: ChatProvider | "AUTO",
  fetcher: UrlFetcher,
): Promise<AccessCheckResult> {
  const valid = validateChatUrl(url);
  if (!valid.ok) return invalidUrlResult(url, provider, valid.error);
  const resolved = resolveProvider(valid.href, provider);
  try {
    const page = await fetcher(valid.href);
    return evaluateAccess({ requestedUrl: valid.href, provider: resolved, page });
  } catch (error) {
    return accessCheckException(valid.href, error);
  }
}

export async function importUrlAccess(
  url: string,
  provider: ChatProvider | "AUTO",
  fetcher: UrlFetcher,
): Promise<{ access: AccessCheckResult; rawContent: string }> {
  const valid = validateChatUrl(url);
  if (!valid.ok) {
    return {
      access: await checkUrlAccess(url, provider, fetcher),
      rawContent: "",
    };
  }
  const resolved = resolveProvider(valid.href, provider);
  try {
    const page = await fetcher(valid.href);
    const access = evaluateAccess({ requestedUrl: valid.href, provider: resolved, page });
    if (!access.importAllowed) return { access, rawContent: "" };
    const parsed = parseConversation(resolved, page.body);
    return { access, rawContent: parsed.canonicalRaw || page.body };
  } catch (error) {
    return { access: accessCheckException(valid.href, error), rawContent: "" };
  }
}

export function titleFromImport(
  optionalTitle: string,
  hint: string | null,
  provider: ChatProvider,
  method: string,
): string {
  if (optionalTitle.trim()) return optionalTitle.trim();
  if (hint && hint.trim()) return hint.trim();
  return `${provider} ${method.toLowerCase()}`;
}

export { parseConversation };
