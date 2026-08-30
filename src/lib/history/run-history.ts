import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { accessCheckException } from "./access.ts";
import { checkUrlAccess, importUrlAccess } from "./pipeline.ts";
import type { AccessCheckResult, ChatProvider } from "./types.ts";

function asProvider(value: unknown): ChatProvider | "AUTO" {
  if (
    value === "AUTO" ||
    value === "CHATGPT" ||
    value === "GROK" ||
    value === "GROK_BUILD" ||
    value === "CLAUDE" ||
    value === "UNKNOWN"
  ) {
    return value;
  }
  return "AUTO";
}

export const checkChatUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { url: string; provider?: ChatProvider | "AUTO" }) => {
    if (!data || typeof data.url !== "string") {
      throw new Error("A chat URL is required.");
    }
    return { url: data.url, provider: asProvider(data.provider) };
  })
  .handler(async ({ data }): Promise<AccessCheckResult> => {
    try {
      const { fetchChatPage } = await import("./fetch.server.ts");
      return await checkUrlAccess(data.url, data.provider, fetchChatPage);
    } catch (error) {
      return accessCheckException(data.url, error);
    }
  });

export const importChatUrl = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { url: string; provider?: ChatProvider | "AUTO" }) => {
    if (!data || typeof data.url !== "string") {
      throw new Error("A chat URL is required.");
    }
    return { url: data.url, provider: asProvider(data.provider) };
  })
  .handler(async ({ data }): Promise<{ access: AccessCheckResult; rawContent: string }> => {
    try {
      const { fetchChatPage } = await import("./fetch.server.ts");
      return await importUrlAccess(data.url, data.provider, fetchChatPage);
    } catch (error) {
      return { access: accessCheckException(data.url, error), rawContent: "" };
    }
  });
