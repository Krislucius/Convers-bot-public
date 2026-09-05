import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextItem, ProjectFile, Task } from "../council/types.ts";
import { CURRENT_CONTEXT_PACKER, CURRENT_CONTEXT_TOKEN_LIMIT } from "../architecture/contracts.ts";
import { hashContent } from "../history/hash.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import { parseCitation } from "./extract.ts";
import { memoryCache } from "./extract.ts";
import { packEvidence, SOURCE_CAP_RATIO, assemblePackedContext, OMITTED_CLAIM_CHARS, claimLine } from "./pack.ts";
import { coverageBlocksCouncil, runEvidencePipeline, sourceNeedsReimport } from "./pipeline.ts";
import { cachedEvidencePipeline, clearEvidencePipelineCache, evidencePipelineKey } from "./pipeline-cache.ts";
import { persistableManifest } from "../council/manifest.ts";
import { OMITTED_PERSIST_MAX } from "./types.ts";
import {
  PACKED_CITATION_PREVIEW,
  ledgerFoldLabel,
  ledgerFoldLabelFromManifest,
  truncateClaim,
  visiblePackedCitations,
} from "./preview.ts";
import { countTokens } from "./tokens.ts";
import { COVERAGE_COMPLETE_MEANING, type EvidenceManifest } from "./types.ts";

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
    provider: null,
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
    assert.ok(countTokens(result.pack.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);
    assert.equal(result.pack.totalTokens, countTokens(result.pack.text));
    assert.equal(result.coverage.sources[0]?.omittedReason, null);
    assert.ok(result.pack.packed.length > 0);
    assert.ok(result.pack.omitted.some((row) => row.reason === "BUDGET"));
    assert.equal(result.pack.omitted.some((row) => row.reason === "SOURCE_CAP"), false);
    assert.equal(result.coverage.audit.chunksProcessed, result.coverage.audit.chunksTotal);
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
    const bigTurns = Array.from({ length: 400 }, (_, i) =>
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
    assert.equal(second.coverage.sources[0]?.processedChunks, second.coverage.sources[0]?.chunkCount);
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

  it("counts CJK and long tokens deterministically and never overflows the token budget", () => {
    assert.equal(countTokens(""), 0);
    assert.equal(countTokens("ok"), 1);
    assert.equal(countTokens("时钟"), 2);
    assert.equal(countTokens("A".repeat(8)), 2);
    const cjk = "时钟必须保持独立。匹配引擎不得混用库存时钟。".repeat(80);
    const long = `Clocks stay distinct. ${"A".repeat(4000)}`;
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["cjk", "long"] }),
      frozen: [],
      chatSources: [chat("cjk", "cjk", cjk), chat("long", "long", long)],
      historyMessages: [message("cjk", 1, cjk), message("long", 1, long)],
      projectFiles: [],
    });
    assert.equal(result.coverage.status, "COMPLETE");
    assert.ok(countTokens(result.pack.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);
    assert.equal(result.pack.totalTokens, countTokens(result.pack.text));
    const cut = result.pack.text.indexOf("\n## EVIDENCE LEDGER");
    assert.ok(cut > 0);
    assert.equal(result.pack.text, assemblePackedContext(result.pack.text.slice(0, cut), result.pack.packed));
  });

  it("exposes a coverage audit: processed chunks, not semantic recall", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [chat("c1", "c", "Clocks stay distinct inside the matching engine forever.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct inside the matching engine forever.")],
      projectFiles: [],
    });
    const audit = result.coverage.audit;
    assert.equal(audit.chunksTotal, result.chunks.length);
    assert.equal(audit.chunksProcessed, result.chunks.length);
    assert.equal(audit.chunksWithEvidence + audit.chunksWithoutEvidence, audit.chunksProcessed);
    assert.equal(audit.evidenceCount, result.entries.length);
    assert.equal(audit.packedEvidence, result.pack.packed.length);
    assert.equal(audit.omittedEvidence, result.pack.omitted.length);
    assert.equal(result.coverage.status, "COMPLETE");
    assert.equal(result.coverage.meaning, COVERAGE_COMPLETE_MEANING);
    assert.equal(result.manifest.coverageMeaning, COVERAGE_COMPLETE_MEANING);
    assert.deepEqual(result.manifest.audit, audit);
  });

  it("treats zero-evidence chunks as processed COMPLETE coverage", () => {
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [chat("c1", "short", "ok\nyes\nhi")],
      historyMessages: [message("c1", 1, "ok"), message("c1", 2, "yes"), message("c1", 3, "hi")],
      projectFiles: [],
    });
    assert.equal(result.coverage.status, "COMPLETE");
    assert.ok(result.coverage.audit.chunksTotal >= 3);
    assert.equal(result.coverage.audit.chunksProcessed, result.coverage.audit.chunksTotal);
    assert.ok(result.coverage.audit.chunksWithoutEvidence >= 3);
    assert.equal(result.coverage.audit.evidenceCount, 0);
    assert.equal(coverageBlocksCouncil(result.coverage), null);
  });

  it("lets a single huge source use the full evidence token budget", () => {
    const turns = Array.from({ length: 400 }, (_, i) =>
      message("only", i + 1, `Single source claim ${i} documents that clocks stay distinct under matching load.`),
    );
    const result = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["only"] }),
      frozen: [],
      chatSources: [chat("only", "only", turns.map((row) => row.content).join("\n"))],
      historyMessages: turns,
      projectFiles: [],
    });
    assert.equal(result.pack.omitted.some((row) => row.reason === "SOURCE_CAP"), false);
    assert.ok(result.pack.omitted.some((row) => row.reason === "BUDGET"));
    assert.ok(countTokens(result.pack.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);
    assert.ok(result.pack.packed.length > 0);
  });

  it("applies a diversity cap across many sources then redistributes leftover budget", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const turns = ids.flatMap((id) =>
      Array.from({ length: 12 }, (_, n) =>
        message(id, n + 1, `${id} claim ${n} says clocks stay distinct in the matching engine domain.`),
      ),
    );
    const result = runEvidencePipeline({
      project,
      task: task({
        selectedChatSourceIds: ids,
        prompt: "clocks stay distinct matching engine",
      }),
      frozen: [],
      chatSources: ids.map((id) => chat(id, id, `${id} clocks stay distinct in the matching engine domain.`)),
      historyMessages: turns,
      projectFiles: [],
    });
    const packedSources = new Set(result.pack.packed.map((row) => row.sourceId));
    assert.equal(packedSources.size, ids.length);
    assert.ok(countTokens(result.pack.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);

    const small = message("small", 1, "Inventory clock must remain a separate domain from matching.");
    const bigTurns = Array.from({ length: 400 }, (_, i) =>
      message("big", i + 1, `Dominating source ${i} about clocks stay distinct and matching engine clocks.`),
    );
    const mixed = runEvidencePipeline({
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
    const mandatory = mixed.pack.text.slice(0, mixed.pack.text.indexOf("\n## EVIDENCE LEDGER"));
    const remaining = CURRENT_CONTEXT_TOKEN_LIMIT - countTokens(mandatory);
    const cap = Math.floor(remaining * SOURCE_CAP_RATIO);
    const bigLines = mixed.pack.packed
      .filter((row) => row.sourceId === "big")
      .map((row) => `- [${row.status}] ${row.claim} ${row.citation}`)
      .join("\n");
    assert.ok(mixed.pack.packed.some((row) => row.sourceId === "small"));
    assert.ok(countTokens(bigLines) > cap);
    assert.ok(countTokens(mixed.pack.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);
  });

  it("repeats packing identically including token counts", () => {
    const input = {
      project,
      task: task({ selectedChatSourceIds: ["c1", "c2"] }),
      frozen: [] as ContextItem[],
      chatSources: [
        chat("c1", "one", "First source records that clocks stay distinct."),
        chat("c2", "two", "Second source forbids mixing inventory clocks."),
      ],
      historyMessages: [
        message("c1", 1, "First source records that clocks stay distinct."),
        message("c2", 1, "Second source forbids mixing inventory clocks."),
      ],
      projectFiles: [] as ProjectFile[],
    };
    const a = runEvidencePipeline(input);
    const b = runEvidencePipeline(input);
    assert.equal(a.pack.text, b.pack.text);
    assert.equal(a.pack.totalTokens, b.pack.totalTokens);
    assert.equal(a.manifest.contextHash, b.manifest.contextHash);
    assert.deepEqual(a.coverage.audit, b.coverage.audit);
  });
});

describe("evidence preview helpers", () => {
  it("caps packed citations at five until show-all", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `c${i}`);
    assert.deepEqual(visiblePackedCitations(rows, false), rows.slice(0, PACKED_CITATION_PREVIEW));
    assert.equal(visiblePackedCitations(rows, false).length, 5);
    assert.deepEqual(visiblePackedCitations(rows, true), rows);
    assert.deepEqual(visiblePackedCitations([], false), []);
    assert.deepEqual(visiblePackedCitations(rows.slice(0, 3), false), rows.slice(0, 3));
  });

  it("formats the collapsed ledger header as status | sources | chunks | claims | packed", () => {
    assert.equal(
      ledgerFoldLabel({ status: "COMPLETE", sources: 3, chunks: 12, claims: 40, packed: 5 }),
      "COMPLETE | 3 sources | 12 chunks | 40 claims | 5 packed",
    );
    assert.equal(
      ledgerFoldLabel({ status: "PARTIAL", sources: 0, chunks: 0, claims: 0, packed: 0 }),
      "PARTIAL | 0 sources | 0 chunks | 0 claims | 0 packed",
    );
  });

  it("reads the fold label from a manifest audit", () => {
    const label = ledgerFoldLabelFromManifest({
      coverageStatus: "COMPLETE",
      sources: [{}, {}] as EvidenceManifest["sources"],
      evidenceCount: 9,
      audit: {
        chunksTotal: 10,
        chunksProcessed: 10,
        chunksWithEvidence: 8,
        chunksWithoutEvidence: 2,
        evidenceCount: 9,
        packedEvidence: 5,
        omittedEvidence: 4,
      },
    });
    assert.equal(label, "COMPLETE | 2 sources | 10 chunks | 9 claims | 5 packed");
  });

  it("truncates long claims and keeps short claims intact", () => {
    assert.equal(truncateClaim("short"), "short");
    assert.equal(truncateClaim("  padded  "), "padded");
    const long = `${"word ".repeat(80)}end`;
    const cut = truncateClaim(long);
    assert.ok(cut.endsWith("…"));
    assert.equal(cut.length, 161);
    assert.equal(truncateClaim(long, 20).length, 21);
  });
});

describe("packer performance and pipeline cache", () => {
  function entry(i: number, sourceId = "file1"): import("./types.ts").LedgerEntry {
    return {
      id: `e${i}`,
      chunkId: `c${i % 543}`,
      projectId: "p1",
      sourceKind: sourceId === "file1" ? "FILE" : "CHAT",
      sourceId,
      claim: `Historically asserted claim ${i} describes a frozen contract about clocks stay distinct in matching.`,
      status: "HISTORICALLY_ASSERTED",
      citation: sourceId === "file1" ? `[FILE:file1:${i}-${i + 40}]` : `[CHAT:chat1:${i}]`,
      extractorFingerprint: "fp",
      kind: "EVIDENCE",
    };
  }

  it("packs 20k claims without a multi-second stall and keeps packed text in budget", () => {
    const entries = Array.from({ length: 20000 }, (_, i) => entry(i, i % 3 === 0 ? "chat1" : "file1"));
    const started = performance.now();
    const packed = packEvidence({
      project,
      task: task({ selectedChatSourceIds: ["chat1"], selectedFileIds: ["file1"] }),
      frozen: [],
      entries,
      selectedSourceCount: 2,
    });
    const ms = performance.now() - started;
    assert.equal(packed.ok, true);
    assert.ok(packed.packed.length > 0);
    assert.ok(countTokens(packed.text) <= CURRENT_CONTEXT_TOKEN_LIMIT);
    assert.equal(packed.totalTokens, countTokens(packed.text));
    assert.ok(ms < 800, `packer took ${Math.round(ms)}ms`);
    assert.ok(packed.omitted.every((row) => row.claim.length <= OMITTED_CLAIM_CHARS + 1));
  });

  it("matches incremental accounting against full assembled packed text", () => {
    const entries = Array.from({ length: 400 }, (_, i) => entry(i));
    const packed = packEvidence({
      project,
      task: task({ selectedFileIds: ["file1"] }),
      frozen: [],
      entries,
      selectedSourceCount: 1,
    });
    assert.equal(packed.text, assemblePackedContext(packed.text.slice(0, packed.text.indexOf("\n## EVIDENCE LEDGER")), packed.packed));
    const lines = packed.packed.map(claimLine).join("\n");
    assert.ok(packed.text.includes(lines.slice(0, 80)));
    assert.ok(packed.omitted.some((row) => row.reason === "BUDGET"));
  });

  it("caps persisted omitted payload while keeping full omission counts", () => {
    const entries = Array.from({ length: 3000 }, (_, i) => entry(i));
    const result = packEvidence({
      project,
      task: task({ selectedFileIds: ["file1"] }),
      frozen: [],
      entries,
      selectedSourceCount: 1,
    });
    const pipeline = runEvidencePipeline({
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [],
      chatSources: [
        chat(
          "c1",
          "huge",
          Array.from({ length: 80 }, (_, i) => `Turn ${i} documents that clocks stay distinct under matching load.`).join("\n\n"),
        ),
      ],
      historyMessages: Array.from({ length: 80 }, (_, i) =>
        message("c1", i + 1, `Turn ${i} documents that clocks stay distinct under matching load.`),
      ),
      projectFiles: [],
    });
    assert.ok(pipeline.pack.omitted.length >= pipeline.manifest.omitted.length);
    assert.ok(pipeline.manifest.omitted.length <= OMITTED_PERSIST_MAX);
    assert.equal(pipeline.manifest.audit.omittedEvidence, pipeline.pack.omitted.length);
    const persisted = persistableManifest({
      project: { id: "p1", name: project.name, description: project.description, createdAt: "" },
      task: task({ selectedChatSourceIds: ["c1"] }),
      context: [],
      chatSources: [],
      historyMessages: [],
      artifacts: [],
      projectFiles: [],
      contextText: pipeline.pack.text,
      evidence: pipeline.manifest,
    });
    assert.ok(JSON.stringify(persisted.payload.evidence?.omitted ?? []).length < 200_000);
    assert.ok(result.omitted.length > 0);
  });

  it("reuses a cached pipeline on repeated renders and Run", () => {
    clearEvidencePipelineCache();
    const input = {
      project,
      task: task({ selectedChatSourceIds: ["c1"] }),
      frozen: [] as ContextItem[],
      chatSources: [chat("c1", "chat", "Clocks stay distinct and inventory stays isolated.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct and inventory stays isolated.")],
      projectFiles: [] as ProjectFile[],
    };
    const first = cachedEvidencePipeline(input);
    const second = cachedEvidencePipeline(input);
    assert.equal(first, second);
    assert.equal(first.pack.text, second.pack.text);
    const third = cachedEvidencePipeline({
      ...input,
      task: task({ selectedChatSourceIds: ["c1"], prompt: "changed prompt for clocks" }),
    });
    assert.notEqual(third, first);
  });

  it("matches cache keys for setup preview files-all vs Run selected-files", () => {
    clearEvidencePipelineCache();
    const taskRow = task({ selectedChatSourceIds: ["c1"], selectedFileIds: ["file1"] });
    const selected = file("file1", "Clocks stay distinct under matching load.");
    const extra = file("file2", "Unrelated extra source stays out of the selected set.");
    const base = {
      project,
      task: taskRow,
      frozen: [] as ContextItem[],
      chatSources: [chat("c1", "chat", "Clocks stay distinct and inventory stays isolated.")],
      historyMessages: [message("c1", 1, "Clocks stay distinct and inventory stays isolated.")],
    };
    const panel = { ...base, projectFiles: [selected, extra] };
    const run = { ...base, projectFiles: [selected] };
    assert.equal(evidencePipelineKey(panel), evidencePipelineKey(run));
    const prepared = cachedEvidencePipeline(panel);
    const reused = cachedEvidencePipeline(run);
    assert.equal(prepared, reused);
  });
});
