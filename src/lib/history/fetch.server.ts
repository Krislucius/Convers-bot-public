import type { FetchedPage } from "./types.ts";

const MAX_BYTES = 8_000_000;
const TIMEOUT_MS = 20_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; ConversationBot/0.1.2; +https://grok.x.ai) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function fetchChatPage(url: string): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
        "User-Agent": USER_AGENT,
      },
    });
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          if (received >= MAX_BYTES) {
            truncated = true;
            break;
          }
          const room = MAX_BYTES - received;
          if (value.byteLength > room) {
            chunks.push(value.slice(0, room));
            received += room;
            truncated = true;
            break;
          }
          chunks.push(value);
          received += value.byteLength;
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* already released */
        }
        if (truncated) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      const buffer = await response.arrayBuffer();
      truncated = buffer.byteLength > MAX_BYTES;
      const slice = truncated ? buffer.slice(0, MAX_BYTES) : buffer;
      const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return {
        status: response.status,
        finalUrl: response.url || url,
        contentType: response.headers.get("content-type") ?? "",
        body,
        truncated,
      };
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks, received));
    return {
      status: response.status,
      finalUrl: response.url || url,
      contentType: response.headers.get("content-type") ?? "",
      body,
      truncated,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The URL check timed out."
        : error instanceof Error
          ? error.message
          : "The URL could not be fetched.";
    return {
      status: 0,
      finalUrl: url,
      contentType: "",
      body: "",
      truncated: false,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
