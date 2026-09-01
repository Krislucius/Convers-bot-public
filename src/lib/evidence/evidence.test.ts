import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextItem, ProjectFile, Task } from "../council/types.ts";
import { CURRENT_CONTEXT_CHAR_LIMIT, CURRENT_CONTEXT_PACKER } from "../architecture/contracts.ts";
import { hashContent } from "../history/hash.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import { parseCitation } from "./extract.ts";
import { memoryCache } from "./extract.ts";
import { packEvidence } from "./pack.ts";
import { coverageBlocksCouncil, runEvidencePipeline, sourceNeedsReimport } from "./pipeline.ts";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Keep clocks distinct",
    prompt: "May we use next-minute returns as a feature?",
    status: "CREATED",
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    totalCostUsd: null,
    totalLatencyMs: null,
    diagnostics: null,
    selectedChatSourceIds: [],
    selectedFileIds: [],
    mode: "CREATE",
    requiresHistoricalContext: true,
    candidateArtifactId: null,
    decisionQuestion: null,
    contextManifestId: null,
    contextHash: null,
    ...over,
  };
}

function chat(id: string, title: string, body: string, projectId = "p1"): ChatSource {
  return {
    id,
    projectId,
    provider: "CHATGPT",
    title,
    sourceUrl: null,
    importMethod: "PASTE",
    accessStatus: "ACCESSIBLE",
    importStatus: "IMPORTED",
    rawContent: body,
    messageCount: 1,
    characterCount: body.length,
    estimatedTokenCount: Math.ceil(body.length / 4),
    contentHash: hashContent(body),
    createdAt: "2026-01-01T00:00:00.000Z",
    importedAt: "2026-01-01T00:00:00.000Z",
    lastAccessCheckAt: null,
    lastError: null,
    includeInMemory: true,
  };
}

function message(sourceId: string, sequence: number, content: string): HistoryMessage {
  return {
    id: `${sourceId}-${sequence}`,
    chatSourceId: sourceId,
    sequence,
    speaker: "user",
    role: sequence % 2 ? "USER" : "ASSISTANT",
    content,
    timestamp: null,
  };
}

function file(id: string, text: string, notes = ""): ProjectFile {
  return {
    id,
    projectId: "p1",
    filename: `${id}.md`,
    kind: "MD",
    extractedText: text,
    members: [],
    notes,
    sizeBytes: text.length,
    characterCount: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    includeInMemory: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const project = { id: "p1", name: "DEX", description: "clocks stay distinct" };

describe("evidence ledger pipeline", () => {
  it("uses the evidence ledger packer, not first-N slice", () => {
    assert.equal(CURRENT_CONTEXT_PACKER, "evidenceLedgerPacker");
  });

  it("processes a huge chat history without silent source loss", () => {
    const turns: HistoryMessage[] = [];
    for (let i = 1; i <= 400; i += 1) {
      turns.push(message("c1", i, `Turn ${i} documents that clocks stay distinct under load.`));
    }
    const body = turns.map((row) => row.content).join("\n");
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [chat("c1", "huge", body)],
      historyMessages: turns,
      projectFiles: [],
    });
    assert.equal(result.coverage.status, "COMPLETE");
    assert.equal(result.coverage.sources.length, 1);
    assert.ok(result.chunks.length >= 400);
    assert.ok(result.pack.text.length <= CURRENT_CONTEXT_CHAR_LIMIT);
    assert.equal(result.coverage.sources[0]?.omittedReason, null);
    assert.ok(result.pack.packed.length > 0);
    assert.ok(result.pack.omitted.some((row) => row.reason === "BUDGET" || row.reason === "SOURCE_CAP"));
  });

  it("chunks files larger than 200k characters", () => {
    const text = `${"Architecture decision: clocks stay distinct. ".repeat(6000)}`;
    assert.ok(text.length > 200_000);
    const result = runEvidencePipeline({
      project,
      task: task({ selectedFileIds: ["f1"] }),
      frozen: [],
      chatSources: [],
      historyMessages: [],
      projectFiles: [file("f1", text)],
    });
    assert.equal(result.coverage.status, "COMPLETE");
    assert.ok(result.chunks.length > 1);
    assert.ok(result.chunks.reduce((sum, row) => sum + row.text.length, 0) >= text.length - 10);
    assert.equal(sourceNeedsReimport({ kind: "FILE", extractedText: text, messages: 0 }), false);
  });

  it("packs deterministically despite adversarial source order", () => {
    const a = chat("a", "A", "Alpha clock isolation is mandatory for the matching engine.");
    const b = chat("b", "B", "Beta inventory must never share a clock with alpha.");
    const turns = [
      message("a", 1, "Alpha clock isolation is mandatory for the matching engine."),
      message("b", 1, "Beta inventory must never share a clock with alpha."),
    ];
    const first = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["a", "b"] }),
      frozen: [],
      chatSources: [b, a],
      historyMessages: turns,
      projectFiles: [],
    });
    const second = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["a", "b"] }),
      frozen: [],
      chatSources: [a, b],
      historyMessages: [...turns].reverse(),
      projectFiles: [],
    });
    assert.equal(first.pack.text, second.pack.text);
    assert.equal(first.manifest.ledgerHash, second.manifest.ledgerHash);
    assert.equal(first.manifest.contextHash, second.manifest.contextHash);
  });

  it("caps a dominating source so other sources still pack", () => {
    const bigTurns = Array.from({ length: 80 }, (_, i) =>
      message("big", i + 1, `Dominating source ${i} about clocks stay distinct and matching engine clocks.`),
    );
    const small = message("small", 1, "Inventory clock must remain a separate domain from matching.");
    const result = runEvidencePipeline({
      project,
      task: task({
        selectedChatSourceIds: ["big", "small"],
        prompt: "inventory clock matching engine",
      }),
      frozen: [],
      chatSources: [
        chat("big", "big", bigTurns.map((row) => row.content).join("\n")),
        chat("small", "small", small.content),
      ],
      historyMessages: [...bigTurns, small],
      projectFiles: [],
    });
    const packedSources = new Set(result.pack.packed.map((row) => row.sourceId));
    assert.ok(packedSources.has("small"));
    assert.ok(result.pack.omitted.some((row) => row.sourceId === "big" && row.reason === "SOURCE_CAP"));
  });

  it("deduplicates identical claims across duplicate sources", () => {
    const text = "Clocks stay distinct across every matching engine replica.";
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1", "c2"] }),
      frozen: [],
      chatSources: [chat("c1", "one", text), chat("c2", "two", text)],
      historyMessages: [message("c1", 1, text), message("c2", 1, text)],
      projectFiles: [],
    });
    assert.equal(result.coverage.sources.length, 2);
    assert.ok(result.pack.omitted.some((row) => row.reason === "DUPLICATE"));
    const packedClaims = result.pack.packed.map((row) => row.claim.toLowerCase());
    assert.equal(new Set(packedClaims).size, packedClaims.length);
  });

  it("hits cache on repeat and invalidates when source hash changes", () => {
    const cache = memoryCache();
    const t = task({ selectedChatSourceIds: ["c1"] });
    const first = runEvidencePipeline({
      project,
      task: t,
      frozen: [],
      chatSources: [chat("c1", "v1", "Clocks stay distinct in version one of the protocol.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct in version one of the protocol.")],
      projectFiles: [],
      cache,
    });
    assert.equal(first.coverage.cacheHits, 0);
    const second = runEvidencePipeline({
      project,
      task: t,
      frozen: [],
      chatSources: [chat("c1", "v1", "Clocks stay distinct in version one of the protocol.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct in version one of the protocol.")],
      projectFiles: [],
      cache,
    });
    assert.equal(second.coverage.cacheHits, 1);
    assert.equal(second.coverage.sources[0]?.status, "CACHE_HIT");
    const third = runEvidencePipeline({
      project,
      task: t,
      frozen: [],
      chatSources: [chat("c1", "v2", "Clocks stay distinct in version two after the hash changed.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct in version two after the hash changed.")],
      projectFiles: [],
      cache,
    });
    assert.equal(third.coverage.cacheHits, 0);
    assert.notEqual(third.manifest.ledgerHash, second.manifest.ledgerHash);
  });

  it("resumes interrupted extraction from cache", () => {
    const cache = memoryCache();
    const t = task({ selectedChatSourceIds: ["c1", "c2"] });
    runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [chat("c1", "one", "First source records that clocks stay distinct.")],
      historyMessages: [message("c1", 1, "First source records that clocks stay distinct.")],
      projectFiles: [],
      cache,
    });
    const resumed = runEvidencePipeline({
      project,
      task: t,
      frozen: [],
      chatSources: [
        chat("c1", "one", "First source records that clocks stay distinct."),
        chat("c2", "two", "Second source forbids mixing inventory clocks."),
      ],
      historyMessages: [
        message("c1", 1, "First source records that clocks stay distinct."),
        message("c2", 1, "Second source forbids mixing inventory clocks."),
      ],
      projectFiles: [],
      cache,
    });
    assert.equal(resumed.coverage.cacheHits, 1);
    assert.equal(resumed.coverage.sources.length, 2);
    assert.ok(resumed.coverage.sources.some((row) => row.status === "CACHE_HIT"));
    assert.ok(resumed.coverage.sources.some((row) => row.status === "COMPLETE" && row.sourceId === "c2"));
  });

  it("marks a failed source among successes as FAILED coverage, never COMPLETE", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["ok", "bad"] }),
      frozen: [],
      chatSources: [
        chat("ok", "ok", "Healthy source says clocks stay distinct in production."),
        chat("bad", "bad", "This source will fail extraction on purpose."),
      ],
      historyMessages: [
        message("ok", 1, "Healthy source says clocks stay distinct in production."),
        message("bad", 1, "This source will fail extraction on purpose."),
      ],
      projectFiles: [],
      failSourceIds: ["bad"],
    });
    assert.equal(result.coverage.status, "FAILED");
    assert.equal(result.coverage.sources.find((row) => row.sourceId === "ok")?.status, "COMPLETE");
    assert.equal(result.coverage.sources.find((row) => row.sourceId === "bad")?.status, "FAILED");
    assert.ok(coverageBlocksCouncil(result.coverage));
  });

  it("round-trips provenance from packed citation to chunk span", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"], selectedFileIds: ["f1"] }),
      frozen: [],
      chatSources: [chat("c1", "chat", "Clocks stay distinct inside the matching engine.")],
      historyMessages: [message("c1", 7, "Clocks stay distinct inside the matching engine.")],
      projectFiles: [file("f1", "Inventory clock remains a separate bounded context.")],
    });
    assert.ok(result.pack.packed.length >= 2);
    for (const entry of result.pack.packed) {
      const parsed = parseCitation(entry.citation);
      assert.ok(parsed);
      const chunk = result.chunks.find((row) => row.id === entry.chunkId);
      assert.ok(chunk);
      assert.equal(parsed?.sourceId, chunk?.sourceId);
      if (chunk?.sourceKind === "CHAT") assert.equal(parsed?.messageSeq, 7);
      if (chunk?.sourceKind === "FILE") {
        assert.equal(parsed?.fileSpan?.start, chunk.fileSpan?.start);
        assert.equal(parsed?.fileSpan?.end, chunk.fileSpan?.end);
      }
    }
  });

  it("repeats packing identically", () => {
    const input = {
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [] as ContextItem[],
      chatSources: [chat("c1", "chat", "Clocks stay distinct and inventory stays isolated.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct and inventory stays isolated.")],
      projectFiles: [] as ProjectFile[],
    };
    const a = runEvidencePipeline(input);
    const b = runEvidencePipeline(input);
    assert.equal(a.pack.text, b.pack.text);
    assert.equal(a.manifest.contextHash, b.manifest.contextHash);
  });

  it("returns CONTEXT_BUDGET_EXCEEDED when mandatory context overflows the budget", () => {
    const frozen: ContextItem[] = [
      {
        id: "inv",
        projectId: "p1",
        source: "USER",
        kind: "INVARIANT",
        status: "FROZEN",
        content: "MANDATORY ".repeat(8000),
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const packed = packEvidence({
      project,
      task: task(),
      frozen,
      entries: [],
    });
    assert.equal(packed.ok, false);
    assert.equal(packed.code, "CONTEXT_BUDGET_EXCEEDED");
    assert.equal(packed.text, "");
  });

  it("keeps project B sources out of project A packing", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["a1", "b1"] }),
      frozen: [],
      chatSources: [
        chat("a1", "A", "Project A clocks stay distinct."),
        chat("b1", "B", "Project B must not leak.", "p2"),
      ],
      historyMessages: [
        message("a1", 1, "Project A clocks stay distinct."),
        message("b1", 1, "Project B must not leak."),
      ],
      projectFiles: [],
    });
    assert.equal(result.coverage.sources.every((row) => row.sourceId !== "b1"), true);
    assert.equal(result.pack.text.includes("Project B must not leak"), false);
  });

  it("never silently drops a selected source from coverage", () => {
    const ids = ["s1", "s2", "s3"];
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ids }),
      frozen: [],
      chatSources: ids.map((id) => chat(id, id, `${id} clocks stay distinct as an isolated domain.`)),
      historyMessages: ids.map((id) => message(id, 1, `${id} clocks stay distinct as an isolated domain.`)),
      projectFiles: [],
    });
    assert.deepEqual(
      result.coverage.sources.map((row) => row.sourceId).sort(),
      ids,
    );
  });

  it("flags previously truncated files as REIMPORT_REQUIRED", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedFileIds: ["f1"] }),
      frozen: [],
      chatSources: [],
      historyMessages: [],
      projectFiles: [file("f1", "partial clocks\n[truncated]", "Extracted text [truncated]")],
    });
    assert.equal(result.coverage.status, "REIMPORT_REQUIRED");
    assert.ok(coverageBlocksCouncil(result.coverage));
  });

  it("never promotes ledger rows to INVARIANT/DECISION/SPEC", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [chat("c1", "c", "This must become an invariant in the operator's mind only.")],
      historyMessages: [message("c1", 1, "This must become an invariant in the operator's mind only.")],
      projectFiles: [],
    });
    assert.ok(result.entries.every((row) => row.kind === "EVIDENCE"));
    assert.equal(result.pack.text.includes("## INVARIANT"), false);
  });
});
