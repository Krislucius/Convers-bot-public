import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTEXT_TOKEN_LIMIT, boundContext, buildContext, estimateCouncilRun } from "./protocol.ts";
import { countTokens } from "../evidence/tokens.ts";
import type { ContextItem, Task } from "./types.ts";

const task: Task = {
  id: "t1",
  projectId: "p1",
  title: "Leak check",
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
  mode: "REVIEW",
  requiresHistoricalContext: false,
  candidateArtifactId: null,
  decisionQuestion: null,
  contextManifestId: null,
  contextHash: null,
};

describe("council estimate", () => {
  it("does not first-N slice oversized raw context", () => {
    const huge = "字".repeat(CONTEXT_TOKEN_LIMIT + 400);
    const ctx = buildContext({ name: "DEX", description: "clocks" }, task, [
      {
        id: "c1",
        projectId: "p1",
        source: "IMPORT",
        kind: "RAW_HISTORY",
        status: "RAW",
        content: huge,
        createdAt: task.createdAt,
      } satisfies ContextItem,
    ]);
    assert.equal(ctx.includes(huge), false);
    assert.ok(countTokens(ctx) <= CONTEXT_TOKEN_LIMIT);
    const estimate = estimateCouncilRun(ctx, 1);
    assert.equal(estimate.capped, false);
    assert.throws(() => boundContext(huge), /CONTEXT_BUDGET_EXCEEDED/);
  });

  it("returns a positive dollar estimate for the 3+3+1 council", () => {
    const ctx = buildContext({ name: "DEX", description: "clocks stay distinct" }, task, []);
    const estimate = estimateCouncilRun(ctx, 1);
    assert.equal(estimate.capped, false);
    assert.equal(estimate.costUsd > 0, true);
    assert.equal(estimate.costUsd < 1, true);
    assert.equal(estimate.overBudget, false);
  });

  it("flags over-budget runs without changing the sent packet", () => {
    const ctx = "short context";
    const estimate = estimateCouncilRun(ctx, 0.0001);
    assert.equal(estimate.overBudget, true);
    assert.equal(estimate.inputChars, ctx.length);
  });

  it("embeds selected project files as untrusted evidence", () => {
    const ctx = buildContext(
      { name: "DEX", description: "clocks stay distinct" },
      { ...task, selectedFileIds: ["f1"] },
      [],
      {
        files: [
          {
            id: "f1",
            projectId: "p1",
            filename: "notes.md",
            kind: "MD",
            extractedText: "BuyFlow must not enter the kernel",
            members: [],
            notes: "md",
            sizeBytes: 12,
            characterCount: 32,
            estimatedTokens: 8,
            includeInMemory: true,
            createdAt: task.createdAt,
          },
        ],
      },
    );
    assert.match(ctx, /SELECTED FILE IDS: f1/);
    assert.equal(ctx.includes("BuyFlow must not enter the kernel"), false);
  });
});
