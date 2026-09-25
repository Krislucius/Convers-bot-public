import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyModelChange,
  buildContextPack,
  createSoloThread,
  executeSoloTurn,
  handoffSnapshot,
  modelMessages,
  parseSseDeltas,
  planModelChange,
  renderSoloMarkdown,
  resumeThread,
  revealChunks,
  seedFromCouncil,
  SOLO_CALLS,
  stopLastAssistant,
} from "./logic.ts";

const now = "2026-09-23T08:00:00.000Z";

function thread() {
  return createSoloThread({
    id: "solo1",
    projectId: "p1",
    provider: "nanogpt",
    modelId: "kimi",
    modelLabel: "Kimi",
    now,
  });
}

describe("solo mode", () => {
  it("keeps a multi-turn thread on one model and passes user text through", async () => {
    const seen: string[][] = [];
    const first = await executeSoloTurn({
      thread: thread(),
      userText: "Привет, расскажи про договор",
      context: {},
      now,
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      complete: async (request) => {
        seen.push(request.messages.filter((row) => row.role === "user").map((row) => row.content));
        assert.equal(request.modelId, "kimi");
        assert.equal(request.provider, "nanogpt");
        return { text: "Ответ один", inputTokens: 3, outputTokens: 2, cost: 0.01, latencyMs: 10 };
      },
    });
    const second = await executeSoloTurn({
      thread: first.thread,
      userText: "And now in English, continue",
      context: {},
      now: "2026-09-23T08:01:00.000Z",
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      complete: async (request) => {
        seen.push(request.messages.filter((row) => row.role === "user").map((row) => row.content));
        assert.equal(request.modelId, "kimi");
        return { text: "English answer [file:f1]", inputTokens: 4, outputTokens: 3, cost: 0.02, latencyMs: 11 };
      },
    });
    assert.deepEqual(seen[0], ["Привет, расскажи про договор"]);
    assert.deepEqual(seen[1], ["Привет, расскажи про договор", "And now in English, continue"]);
    assert.equal(second.usageKind, SOLO_CALLS);
    assert.equal(second.calls, 1);
    assert.equal(second.dispatchedModel, "kimi");
    const restored = resumeThread(JSON.parse(JSON.stringify(second.thread)));
    assert.equal(restored.messages.filter((row) => row.role === "USER").length, 2);
    assert.match(renderSoloMarkdown(restored, ["FILE notes.pdf SOURCE_STATUS=EXTRACTED"]), /nanogpt/);
    assert.match(renderSoloMarkdown(restored, ["FILE notes.pdf SOURCE_STATUS=EXTRACTED"]), /\[file:f1\]/);
    assert.match(renderSoloMarkdown(restored, []), /Привет, расскажи про договор/);
  });

  it("sends extracted PDF text and drops a contradiction", async () => {
    const base = { ...thread(), contextEnabled: true, selectedFileIds: ["f1"] };
    const file = {
      id: "f1",
      filename: "notes.pdf",
      kind: "PDF" as const,
      extractedText: "Привет из PDF. Это достаточно длинный извлечённый текст договора.",
      notes: "",
      characterCount: 70,
    };
    let packed = "";
    const result = await executeSoloTurn({
      thread: base,
      userText: "Что в файле?",
      context: { files: [file] },
      now,
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      complete: async (request) => {
        packed = request.messages[0]?.content ?? "";
        return { text: "The PDF is unreadable.\n\nДоговор есть.", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 };
      },
    });
    assert.match(packed, /SOURCE_STATUS=EXTRACTED/);
    assert.match(packed, /Привет из PDF/);
    const answer = result.thread.messages.find((row) => row.role === "ASSISTANT")?.content ?? "";
    assert.match(answer, /MODEL_SOURCE_STATE_CONTRADICTION/);
    assert.equal(/pdf is unreadable/i.test(answer), false);
    assert.match(answer, /Договор есть/);
    const off = { ...base, contextEnabled: false };
    assert.equal(buildContextPack(off, { files: [file] }).text, "");
  });

  it("requires an explicit model transition and never switches silently", () => {
    const base = thread();
    assert.equal(planModelChange(base, { provider: "openrouter", modelId: "or-1" }).needsConfirm, true);
    assert.equal(applyModelChange(base, { provider: "openrouter", modelId: "or-1" }, now, false).modelId, "kimi");
    const next = applyModelChange(base, { provider: "openrouter", modelId: "or-1", modelLabel: "OR" }, now, true);
    assert.equal(next.provider, "openrouter");
    assert.equal(next.modelId, "or-1");
    assert.equal(next.transitions.length, 1);
    assert.equal(next.messages.some((row) => row.role === "TRANSITION"), true);
  });

  it("stops and regenerates without a second user turn", async () => {
    const result = await executeSoloTurn({
      thread: thread(),
      userText: "hello",
      context: {},
      now,
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      complete: async () => ({ text: "full answer", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 }),
    });
    const stopped = stopLastAssistant(result.thread, "full");
    assert.equal(stopped.messages.at(-1)?.stopped, true);
    assert.equal(stopped.messages.at(-1)?.content, "full");
    const again = await executeSoloTurn({
      thread: stopped,
      regenerate: true,
      context: {},
      now: "2026-09-23T08:02:00.000Z",
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      complete: async (request) => {
        assert.equal(request.messages.filter((row) => row.role === "user").length, 1);
        return { text: "regenerated", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 };
      },
    });
    assert.equal(again.thread.messages.filter((row) => row.role === "USER").length, 1);
    assert.equal(again.thread.messages.filter((row) => row.role === "ASSISTANT").at(-1)?.content, "regenerated");
  });

  it("retries the same model and does not call the model when preflight fails", async () => {
    let calls = 0;
    const retried = await executeSoloTurn({
      thread: thread(),
      userText: "hello",
      context: {},
      now,
      cancelled: () => false,
      preflight: async () => ({ ok: true }),
      retryable: () => true,
      complete: async (request) => {
        calls += 1;
        assert.equal(request.modelId, "kimi");
        if (calls < 2) throw new Error("timeout");
        return { text: "ok", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 };
      },
    });
    assert.equal(retried.calls, 2);
    assert.equal(retried.dispatchedModel, "kimi");
    let completeCalls = 0;
    const blocked = await executeSoloTurn({
      thread: thread(),
      userText: "hello",
      context: {},
      now,
      cancelled: () => false,
      preflight: async () => ({ ok: false, error: "MODEL_UNAVAILABLE" }),
      complete: async () => {
        completeCalls += 1;
        return { text: "nope", inputTokens: 0, outputTokens: 0, cost: 0, latencyMs: 0 };
      },
    });
    assert.equal(completeCalls, 0);
    assert.equal(blocked.error, "MODEL_UNAVAILABLE");
  });

  it("snapshots a solo thread for Council and seeds a follow-up without rerunning Council", () => {
    const base = thread();
    base.messages = [
      { id: "u1", threadId: base.id, role: "USER", content: "question", provider: "nanogpt", modelId: "kimi", createdAt: now, inputTokens: null, outputTokens: null, cost: null, latencyMs: null, error: null, citations: [], stopped: false },
      { id: "a1", threadId: base.id, role: "ASSISTANT", content: "answer", provider: "nanogpt", modelId: "kimi", createdAt: now, inputTokens: null, outputTokens: null, cost: null, latencyMs: null, error: null, citations: [], stopped: false },
    ];
    const all = handoffSnapshot(base, "ALL", now);
    const last = handoffSnapshot(base, "LAST", now);
    assert.equal(all.provenance, "SOLO_THREAD");
    assert.deepEqual(all.messageIds, ["u1", "a1"]);
    assert.deepEqual(last.messageIds, ["a1"]);
    assert.match(all.text, /snapshot_hash/);
    assert.match(all.text, /not a canonical decision/);
    const frozen = all.text;
    base.messages[0]!.content = "changed later";
    assert.equal(all.text, frozen);
    const seeded = seedFromCouncil({
      id: "solo2",
      projectId: "p1",
      provider: "openrouter",
      modelId: "or-1",
      now,
      decision: "Decision record: blocked",
      artifact: "artifact body",
      evidenceRefs: ["[file:f1]"],
    });
    assert.match(seeded.messages[0]?.content ?? "", /Decision record: blocked/);
    assert.match(seeded.messages[0]?.content ?? "", /Do not rerun the Council/);
    assert.equal(seeded.contextEnabled, false);
    assert.equal(modelMessages(seeded, "").some((row) => row.content.includes("Round 1")), false);
  });

  it("keeps answering on the same model after the first reply", async () => {
    let checks = 0;
    const first = await executeSoloTurn({
      thread: thread(),
      userText: "первый",
      context: {},
      now,
      cancelled: () => false,
      preflight: async () => {
        checks += 1;
        return { ok: true };
      },
      complete: async () => ({ text: "ответ", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 }),
    });
    const userAt = first.thread.messages.find((row) => row.role === "USER")?.createdAt ?? "";
    const answerAt = first.thread.messages.find((row) => row.role === "ASSISTANT")?.createdAt ?? "";
    assert.ok(userAt < answerAt);
    const second = await executeSoloTurn({
      thread: first.thread,
      userText: "второй",
      context: {},
      now: "2026-09-23T08:06:00.000Z",
      cancelled: () => false,
      preflight: async () => {
        checks += 1;
        return { ok: false, error: "MODEL_UNAVAILABLE" };
      },
      complete: async (request) => {
        assert.equal(request.modelId, "kimi");
        assert.equal(request.provider, "nanogpt");
        return { text: "дальше", inputTokens: 1, outputTokens: 1, cost: 0, latencyMs: 1 };
      },
    });
    assert.equal(checks, 1);
    assert.equal(second.error, null);
    assert.equal(second.dispatchedModel, "kimi");
    const tied = first.thread.messages.map((row) => ({ ...row, createdAt: now }));
    const restored = resumeThread({ ...first.thread, messages: [...tied].reverse() });
    assert.deepEqual(
      restored.messages.map((row) => row.role),
      ["USER", "ASSISTANT"],
    );
    const broken = modelMessages(
      {
        ...first.thread,
        messages: first.thread.messages.map((row) => (row.role === "ASSISTANT" ? { ...row, content: "", error: "TIMEOUT" } : row)),
      },
      "",
    );
    assert.deepEqual(
      broken.filter((row) => row.role !== "system").map((row) => row.role),
      ["user", "assistant"],
    );
  });

  it("streams deltas and does not import Council orchestration", () => {
    const parsed = parseSseDeltas('data: {"choices":[{"delta":{"content":"При"}}]}\n\ndata: {"choices":[{"delta":{"content":"вет"}}]}\n\ndata: [DONE]\n');
    assert.deepEqual(parsed.deltas, ["При", "вет"]);
    assert.equal(parsed.done, true);
    assert.equal(revealChunks("abcd", 4).at(-1), "abcd");
    const source = readFileSync(new URL("./logic.ts", import.meta.url), "utf8");
    assert.equal(source.includes("runCouncil"), false);
    assert.equal(source.includes("durable-step"), false);
    assert.equal(source.includes("ROUND_1"), false);
    assert.equal(source.includes("member_id"), false);
  });
});
