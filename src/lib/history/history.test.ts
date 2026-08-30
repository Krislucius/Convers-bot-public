import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAccess, accessCheckException, formatAccessLog } from "./access.ts";
import { buildChatSource } from "./build-source.ts";
import { detectProviderFromUrl, isPrivateConversationPath } from "./detect.ts";
import { hashContent } from "./hash.ts";
import { parseConversation } from "./parse.ts";
import { checkUrlAccess } from "./pipeline.ts";
import {
  assertHistoryIsNotCanonical,
  findDuplicate,
  filterSelectedForProject,
  applyRemoteAccessChange,
  selectedChatsToContext,
  sourceHasSecretFields,
  sourcesForProject,
  resolveChatsForRun,
  memoryChatCount,
  memoryChatIds,
} from "./provenance.ts";
import { searchChatSources } from "./search.ts";
import type { ChatSource, FetchedPage, HistoryMessage } from "./types.ts";
import { validateChatUrl } from "./url.ts";

const CHATGPT_MAPPING = {
  title: "Public architecture chat",
  mapping: {
    root: { message: null, parent: null, children: ["m1"] },
    m1: {
      message: {
        author: { role: "user" },
        content: { parts: ["Can we use next-minute returns as a feature?"] },
        create_time: 1700000000,
      },
      parent: "root",
      children: ["m2"],
    },
    m2: {
      message: {
        author: { role: "assistant" },
        content: { parts: ["No. That leaks the label."] },
        create_time: 1700000001,
      },
      parent: "m1",
      children: [],
    },
  },
};

const SHARE_HTML = `<html><head><title>Public architecture chat — ChatGPT</title></head><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { serverResponse: { data: CHATGPT_MAPPING } } } })}</script>
</body></html>`;

function internFlight(root: unknown): unknown[] {
  const table: unknown[] = [];
  function intern(value: unknown): number {
    if (value === undefined || value === null) return -5;
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      const index = table.length;
      table.push(value);
      return index;
    }
    if (Array.isArray(value)) {
      const index = table.length;
      table.push([]);
      table[index] = value.map(intern);
      return index;
    }
    if (typeof value === "object") {
      const index = table.length;
      table.push({});
      const rec: Record<string, number> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        rec[`_${intern(key)}`] = intern(nested);
      }
      table[index] = rec;
      return index;
    }
    return -5;
  }
  intern(root);
  return table;
}

const FLIGHT_HTML = `<html><head><title>ChatGPT - DEX Gem Hunter</title></head><body>
<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(internFlight({
  loaderData: {
    pageTitle: "DEX Gem Hunter",
    serverResponse: {
      data: {
        title: "DEX Gem Hunter",
        mapping: CHATGPT_MAPPING.mapping,
      },
    },
  },
})))});</script>
</body></html>`;

const LOGIN_HTML = `<html><head><title>ChatGPT</title></head><body>
<h1>Log in to continue to ChatGPT</h1>
<form><input type="password" name="password" /></form>
</body></html>`;

const PRICING_HTML = `<html><head><title>Pricing</title></head><body><h1>ChatGPT pricing</h1><p>Plans for everyone.</p></body></html>`;

function page(partial: Partial<FetchedPage> & { status: number }): FetchedPage {
  return {
    finalUrl: partial.finalUrl ?? "https://chatgpt.com/share/abc",
    contentType: partial.contentType ?? "text/html",
    body: partial.body ?? "",
    truncated: false,
    ...partial,
  };
}

function mockFetcher(result: FetchedPage): (url: string) => Promise<FetchedPage> {
  return async () => result;
}

describe("unlimited chat sources", () => {
  it("allows more than ten sources per project with no cap", () => {
    const sources: ChatSource[] = [];
    for (let i = 0; i < 12; i += 1) {
      const built = buildChatSource({
        projectId: "p1",
        provider: i % 2 ? "GROK" : "CHATGPT",
        title: `Chat ${i}`,
        sourceUrl: null,
        importMethod: "PASTE",
        accessStatus: "NOT_CHECKED",
        importStatus: "IMPORTED",
        rawContent: `User: turn ${i}\nAssistant: reply ${i}`,
      });
      sources.push(built.source);
    }
    assert.equal(sourcesForProject(sources, "p1").length, 12);
  });
});

describe("url validation", () => {
  it("rejects malformed URLs safely", () => {
    assert.equal(validateChatUrl("not a url").ok, false);
    assert.equal(validateChatUrl("javascript:alert(1)").ok, false);
    assert.equal(validateChatUrl("ftp://chatgpt.com/share/x").ok, false);
    assert.equal(validateChatUrl("https://127.0.0.1/chat").ok, false);
    assert.equal(validateChatUrl("https://localhost/c/1").ok, false);
    assert.equal(validateChatUrl("https://192.168.0.5/share").ok, false);
    const ok = validateChatUrl("https://chatgpt.com/share/09b018fe-6f20-80a5-bbdb-5a963e1231ae");
    assert.equal(ok.ok, true);
  });

  it("strips credentials from URLs", () => {
    const ok = validateChatUrl("https://user:secret@chatgpt.com/share/abc");
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.href.includes("secret"), false);
  });
});

describe("provider detection", () => {
  it("maps known hosts and does not guess from x.com tweets", () => {
    assert.equal(detectProviderFromUrl("https://chatgpt.com/share/aaa"), "CHATGPT");
    assert.equal(detectProviderFromUrl("https://chat.openai.com/share/aaa"), "CHATGPT");
    assert.equal(detectProviderFromUrl("https://claude.ai/share/aaa"), "CLAUDE");
    assert.equal(detectProviderFromUrl("https://grok.com/share/aaa"), "GROK");
    assert.equal(detectProviderFromUrl("https://grok.com/grok-app-builder/x"), "GROK_BUILD");
    assert.equal(detectProviderFromUrl("https://x.com/i/grok/share/x"), "GROK");
    assert.equal(detectProviderFromUrl("https://x.com/someone/status/1"), "UNKNOWN");
    assert.equal(detectProviderFromUrl("https://example.com/thread"), "UNKNOWN");
    assert.equal(isPrivateConversationPath("CHATGPT", "https://chatgpt.com/c/private"), true);
  });
});

describe("access preflight", () => {
  it("marks a public readable share as ACCESSIBLE", async () => {
    const access = await checkUrlAccess(
      "https://chatgpt.com/share/aaa",
      "AUTO",
      mockFetcher(page({ status: 200, body: SHARE_HTML })),
    );
    assert.equal(access.accessStatus, "ACCESSIBLE");
    assert.equal(access.importAllowed, true);
    assert.equal(access.provider, "CHATGPT");
  });

  it("reads a ChatGPT share from the React Router flight payload", async () => {
    const access = await checkUrlAccess(
      "https://chatgpt.com/share/6a920e9a-cb40-83eb-98bf-05de236792c3",
      "AUTO",
      mockFetcher(page({ status: 200, body: FLIGHT_HTML })),
    );
    assert.equal(access.accessStatus, "ACCESSIBLE");
    assert.equal(access.importAllowed, true);
    assert.equal(access.titleHint, "DEX Gem Hunter");
    const parsed = parseConversation("CHATGPT", FLIGHT_HTML);
    assert.equal(parsed.reliable, true);
    assert.equal(parsed.turns.length, 2);
    assert.equal(parsed.turns[0]?.role, "USER");
  });

  it("marks an authentication wall as AUTH_REQUIRED", async () => {
    const access = await checkUrlAccess(
      "https://chatgpt.com/c/private-id",
      "AUTO",
      mockFetcher(page({ status: 200, finalUrl: "https://chatgpt.com/auth/login", body: LOGIN_HTML })),
    );
    assert.equal(access.accessStatus, "AUTH_REQUIRED");
    assert.equal(access.importAllowed, false);
    assert.match(access.message, /Upload or Paste/);
  });

  it("does not treat a login landing page as a successful import", () => {
    const access = evaluateAccess({
      requestedUrl: "https://chatgpt.com/share/aaa",
      provider: "CHATGPT",
      page: page({ status: 200, body: LOGIN_HTML }),
    });
    assert.equal(access.importAllowed, false);
    assert.notEqual(access.accessStatus, "ACCESSIBLE");
  });

  it("marks a 404 as NOT_FOUND", async () => {
    const access = await checkUrlAccess(
      "https://chatgpt.com/share/missing",
      "CHATGPT",
      mockFetcher(page({ status: 404, body: "not found" })),
    );
    assert.equal(access.accessStatus, "NOT_FOUND");
  });

  it("marks an unsupported provider URL as UNSUPPORTED", async () => {
    const access = await checkUrlAccess(
      "https://chatgpt.com/pricing",
      "AUTO",
      mockFetcher(page({ status: 200, finalUrl: "https://chatgpt.com/pricing", body: PRICING_HTML })),
    );
    assert.equal(access.accessStatus, "UNSUPPORTED");
    assert.equal(access.importAllowed, false);
  });

  it("maps a raw Failed to fetch error to FETCH_FAILED, not a login wall", () => {
    const access = accessCheckException(
      "https://chatgpt.com/share/6a920e9a-cb40-83eb-98bf-05de236792c3",
      new TypeError("Failed to fetch"),
    );
    assert.equal(access.accessStatus, "FETCH_FAILED");
    assert.equal(access.importAllowed, false);
    assert.match(access.message, /not a login wall/i);
  });

  it("formats access logs as pretty JSON with an operation envelope", () => {
    const access = accessCheckException(
      "https://chatgpt.com/share/aaa",
      new TypeError("Failed to fetch"),
    );
    const log = formatAccessLog(access);
    const parsed = JSON.parse(log) as { op: string; result: string; error_message?: string; accessStatus: string };
    assert.equal(parsed.op, "check_url");
    assert.equal(parsed.result, "FAIL");
    assert.equal(parsed.accessStatus, "FETCH_FAILED");
    assert.match(log, /\n {2}"op":/);
  });
});

describe("import formats", () => {
  it("imports uploaded TXT", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "UNKNOWN",
      title: "notes",
      sourceUrl: null,
      importMethod: "FILE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "User: hello from txt\nAssistant: hi from txt",
    });
    assert.equal(built.source.rawContent.includes("hello from txt"), true);
    assert.equal(built.messages.length, 2);
  });

  it("imports uploaded Markdown", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "GROK",
      title: "md",
      sourceUrl: null,
      importMethod: "FILE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "**User:** leak?\n**Grok:** P0 if it sees future labels.",
    });
    assert.equal(built.messages.length, 2);
    assert.equal(built.messages[1].role, "ASSISTANT");
  });

  it("imports uploaded ChatGPT JSON without destroying raw", () => {
    const raw = JSON.stringify(CHATGPT_MAPPING);
    const built = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "",
      sourceUrl: null,
      importMethod: "FILE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: raw,
    });
    assert.equal(built.source.rawContent, raw);
    assert.equal(built.source.title, "Public architecture chat");
    assert.equal(built.messages.length, 2);
    assert.equal(built.messages[0].role, "USER");
  });

  it("imports pasted history", () => {
    const raw = "Human: check invariants\nClaude: I will not freeze this chat.";
    const built = buildChatSource({
      projectId: "p1",
      provider: "CLAUDE",
      title: "paste",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: raw,
    });
    assert.equal(built.source.importMethod, "PASTE");
    assert.equal(built.messages.length, 2);
  });

  it("keeps raw when message boundaries cannot be parsed", () => {
    const raw = "a blob of notes with no speakers at all";
    const parsed = parseConversation("UNKNOWN", raw);
    assert.equal(parsed.reliable, false);
    const built = buildChatSource({
      projectId: "p1",
      provider: "UNKNOWN",
      title: "blob",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: raw,
    });
    assert.equal(built.source.rawContent, raw);
    assert.equal(built.messages.length, 0);
  });
});

describe("duplicate detection", () => {
  it("warns when the same content already exists", () => {
    const raw = "User: same\nAssistant: same";
    const first = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "one",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: raw,
    });
    const secondHash = hashContent(raw);
    const found = findDuplicate([first.source], "p1", secondHash);
    assert.equal(found?.id, first.source.id);
    assert.equal(findDuplicate([first.source], "p2", secondHash), undefined);
  });
});

describe("raw immutability and remote access loss", () => {
  it("does not delete imported content when remote access disappears", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "kept",
      sourceUrl: "https://chatgpt.com/share/aaa",
      importMethod: "URL",
      accessStatus: "ACCESSIBLE",
      importStatus: "IMPORTED",
      rawContent: SHARE_HTML,
    });
    const next = applyRemoteAccessChange(built.source, {
      accessStatus: "AUTH_REQUIRED",
      lastAccessCheckAt: new Date().toISOString(),
      lastError: "HTTP 401",
    });
    assert.equal(next.rawContent, built.source.rawContent);
    assert.equal(next.contentHash, built.source.contentHash);
    assert.equal(next.importedAt, built.source.importedAt);
    assert.equal(next.accessStatus, "AUTH_REQUIRED");
    assert.equal(next.importStatus, "IMPORTED");
  });
});

describe("history is not canonical truth", () => {
  it("never promotes imported chats to frozen invariants", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "GROK",
      title: "review",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "You: freeze this\nGrok: no",
    });
    const items = selectedChatsToContext("p1", [built.source.id], [built.source], built.messages);
    assert.equal(assertHistoryIsNotCanonical(items), true);
    assert.equal(built.source.importStatus, "IMPORTED");
  });
});

describe("privacy", () => {
  it("does not request or persist cookies or passwords", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "x",
      sourceUrl: "https://chatgpt.com/share/aaa",
      importMethod: "URL",
      accessStatus: "ACCESSIBLE",
      importStatus: "IMPORTED",
      rawContent: SHARE_HTML,
    });
    assert.equal(sourceHasSecretFields(built.source), false);
    assert.equal("cookie" in built.source, false);
    assert.equal("password" in built.source, false);
  });
});

describe("project isolation", () => {
  it("one project cannot see another project's chat sources", () => {
    const a = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "alpha",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "User: a\nAssistant: a",
    });
    const b = buildChatSource({
      projectId: "p2",
      provider: "GROK",
      title: "beta",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "You: b\nGrok: b",
    });
    const visible = sourcesForProject([a.source, b.source], "p1");
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, a.source.id);
    const selected = filterSelectedForProject([a.source.id, b.source.id], [a.source, b.source], "p1");
    assert.deepEqual(selected, [a.source.id]);
  });

  it("task-selected chat sources must belong to the same project", () => {
    const local = buildChatSource({
      projectId: "p1",
      provider: "CLAUDE",
      title: "local",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "Human: x\nClaude: y",
    });
    const foreign = buildChatSource({
      projectId: "p2",
      provider: "CLAUDE",
      title: "foreign",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "Human: z\nClaude: z",
    });
    const selected = filterSelectedForProject(
      [local.source.id, foreign.source.id],
      [local.source, foreign.source],
      "p1",
    );
    const items = selectedChatsToContext("p1", selected, [local.source, foreign.source], [
      ...local.messages,
      ...foreign.messages,
    ] as HistoryMessage[]);
    assert.equal(items.length, 1);
    assert.equal(items[0].content.includes("foreign"), false);
  });
});

describe("search", () => {
  it("filters by keyword, provider, and title", () => {
    const a = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "clocks",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "User: prediction_as_of_time\nAssistant: keep it frozen",
    });
    const b = buildChatSource({
      projectId: "p1",
      provider: "GROK",
      title: "unrelated",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "You: hello\nGrok: world",
    });
    const found = searchChatSources([a.source, b.source], [...a.messages, ...b.messages], "p1", {
      q: "prediction_as_of_time",
      provider: "CHATGPT",
      title: "clock",
    });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, a.source.id);
  });
});

describe("project memory and archive", () => {
  it("defaults includeInMemory to false", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "new",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      rawContent: "User: hi\nAssistant: hello",
    });
    assert.equal(built.source.includeInMemory, false);
  });

  it("does not put archived chats in memory even if requested", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "GROK",
      title: "old",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "ARCHIVED",
      includeInMemory: true,
      rawContent: "You: x\nGrok: y",
    });
    assert.equal(built.source.includeInMemory, false);
  });

  it("excludes archived chats from a Council run even if selected", () => {
    const live = buildChatSource({
      projectId: "p1",
      provider: "CHATGPT",
      title: "live",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      includeInMemory: true,
      rawContent: "User: a\nAssistant: a",
    });
    const archived = buildChatSource({
      projectId: "p1",
      provider: "GROK",
      title: "archived",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "ARCHIVED",
      rawContent: "You: b\nGrok: b",
    });
    const chosen = resolveChatsForRun(
      "p1",
      [live.source.id, archived.source.id],
      [live.source, archived.source],
    );
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0].id, live.source.id);
    const items = selectedChatsToContext(
      "p1",
      [live.source.id, archived.source.id],
      [live.source, archived.source],
      [...live.messages, ...archived.messages],
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].content.includes("archived"), false);
  });

  it("empty selection sends no chats", () => {
    const built = buildChatSource({
      projectId: "p1",
      provider: "CLAUDE",
      title: "mem",
      sourceUrl: null,
      importMethod: "PASTE",
      accessStatus: "NOT_CHECKED",
      importStatus: "IMPORTED",
      includeInMemory: true,
      rawContent: "Human: x\nClaude: y",
    });
    assert.equal(resolveChatsForRun("p1", [], [built.source]).length, 0);
    assert.deepEqual(memoryChatIds([built.source], "p1"), [built.source.id]);
    assert.deepEqual(memoryChatCount([built.source], "p1"), { included: 1, total: 1 });
  });
});
