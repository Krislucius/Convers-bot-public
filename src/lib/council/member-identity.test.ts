import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSynthesisResponse, survivingResponses, synthesizerQueue } from "./agents.ts";
import { ensureMembers, membersFromIds } from "./members.ts";
import { runCouncil } from "./orchestrate.ts";
import { aggregateTelemetry } from "./protocol.ts";
import { classifyErrorClass, providerFailure } from "./provider-error.ts";
import type { Completion, ProviderCreds, Task } from "./types.ts";
import type { EvidencePipelineResult } from "../evidence/pipeline-cache.ts";

const five = ensureMembers([
  { role: "LEAD_REASONER", modelId: "openai/gpt-a", label: "A", family: "openai" },
  { role: "ADVERSARIAL", modelId: "x-ai/grok-b", label: "B", family: "xai" },
  { role: "ADVERSARIAL", modelId: "deepseek/r1-c", label: "C", family: "deepseek" },
  { role: "ADVERSARIAL", modelId: "google/gemma-d", label: "D", family: "google" },
  { role: "FORMAL_REVIEW", modelId: "anthropic/claude-e", label: "E", family: "anthropic" },
]);

const creds: ProviderCreds = {
  provider: "openrouter",
  apiKey: "test-key",
  members: five,
  synthesizerModel: "openai/gpt-a",
  maxCostUsd: 5,
};

const task: Task = {
  id: "task-identity",
  projectId: "p1",
  title: "Identity",
  prompt: "Reconstruct.",
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
  requiresHistoricalContext: false,
  candidateArtifactId: null,
  decisionQuestion: null,
  contextManifestId: null,
  contextHash: null,
  provider: "openrouter",
};

const pipeline: EvidencePipelineResult = {
  chunks: [],
  entries: [],
  coverage: {
    status: "COMPLETE",
    meaning: "COMPLETE",
    sources: [],
    audit: {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksWithEvidence: 0,
      chunksWithoutEvidence: 0,
      evidenceCount: 0,
      packedEvidence: 0,
      omittedEvidence: 0,
    },
    chunkCount: 0,
    evidenceCount: 0,
    cacheHits: 0,
    extractorFingerprint: "x",
    chunkerVersion: "chunker-v1",
  },
  pack: {
    ok: true,
    code: "OK",
    text: "INVARIANTS\nnone",
    packed: [],
    omitted: [],
    mandatoryTokens: 4,
    evidenceTokens: 0,
    totalTokens: 4,
  },
  manifest: {
    extractorFingerprint: "x",
    chunkerVersion: "chunker-v1",
    packerVersion: "packer-v2",
    coverageStatus: "COMPLETE",
    coverageMeaning: "COMPLETE",
    ledgerHash: "l",
    contextHash: "c",
    selectedSourceHashes: [],
    sources: [],
    packedCitations: [],
    omitted: [],
    audit: {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksWithEvidence: 0,
      chunksWithoutEvidence: 0,
      evidenceCount: 0,
      packedEvidence: 0,
      omittedEvidence: 0,
    },
    evidenceCount: 0,
    chunkCount: 0,
    cacheHits: 0,
    processedChunks: 0,
  },
};

function completion(model: string, extras: Partial<Completion> = {}): Completion {
  return {
    text: `POSITION\n${model} ok\nP0_BLOCKERS\nnone\nP1_ARCHITECTURE\nnone\nP2_CORRECTNESS\nnone\nP3_ROBUSTNESS\nnone\nP4_IMPROVEMENTS\nnone\nRECOMMENDATION\ngo`,
    model,
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 8,
    reasoningTokens: 0,
    cost: extras.cost === undefined ? 0.001 : extras.cost,
    requestId: `${model}-req`,
    latencyMs: 5,
    ...extras,
  };
}

function artifactJson(ids: string[]) {
  return JSON.stringify({
    status: "APPROVED",
    consensus: ["ok"],
    disagreements: [],
    blockers: [],
    recommendation: "go",
    agent_positions: Object.fromEntries(ids.map((id) => [id, "ok"])),
    citations: [],
    resolved_issues: [],
    unresolved_issues: [],
    artifact: {
      type: "SPECIFICATION",
      title: "Spec",
      version: "1.0",
      content: "# Spec",
      evidenceLabels: [{ claim: "ok", status: "UNKNOWN", citation: "" }],
    },
  });
}

describe("council member identity", () => {
  it("gives five unique member_ids when three share a role", () => {
    assert.equal(five.length, 5);
    assert.equal(new Set(five.map((row) => row.memberId)).size, 5);
    assert.equal(five.filter((row) => row.role === "ADVERSARIAL").length, 3);
    const preserved = ensureMembers(five);
    assert.deepEqual(
      preserved.map((row) => row.memberId),
      five.map((row) => row.memberId),
    );
  });

  it("dispatches five distinct Round-1 model ids without role collision", async () => {
    const round1: string[] = [];
    const byMember = new Map<string, string[]>();
    const out = await runCouncil({
      creds,
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          if (!opts.responseFormat && !opts.messages.some((row) => row.content.includes("YOUR ROUND 1 POSITION"))) {
            round1.push(opts.model);
          }
          if (opts.responseFormat) {
            return { ok: true, completion: { ...completion(opts.model), text: artifactJson(five.map((row) => row.memberId)) } };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        yieldFn: async () => undefined,
      },
      onProgress: (progress) => {
        for (const [id, row] of Object.entries(progress.agents ?? {})) {
          if (!row) continue;
          const list = byMember.get(id) ?? [];
          list.push(row.state);
          byMember.set(id, list);
        }
      },
    });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(round1.length, 5);
    assert.deepEqual([...round1].sort(), five.map((row) => row.modelId).sort());
    assert.equal(new Set(round1).size, 5);
    const r1 = out.responses.filter((row) => row.round === 1);
    assert.equal(new Set(r1.map((row) => row.memberId)).size, 5);
    assert.ok(r1.every((row) => row.dispatchedModelId === five.find((item) => item.memberId === row.memberId)?.modelId));
    assert.equal(byMember.size, 5);
  });

  it("keeps duplicate-role retries on the originating member_id", async () => {
    const seen: Array<{ model: string; stage: string }> = [];
    let gemmaTries = 0;
    const out = await runCouncil({
      creds,
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          seen.push({ model: opts.model, stage: opts.responseFormat ? "SYNTHESIS" : "CALL" });
          if (opts.model.includes("gemma") && gemmaTries < 2 && !opts.responseFormat) {
            gemmaTries += 1;
            return {
              ok: false,
              error: "429",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "ROUND_1",
                httpStatus: 429,
                errorClass: "RATE_LIMITED",
              }),
            };
          }
          if (opts.responseFormat) {
            return { ok: true, completion: { ...completion(opts.model), text: artifactJson(five.map((row) => row.memberId)) } };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        yieldFn: async () => undefined,
      },
    });
    const gemma = five.find((row) => row.modelId.includes("gemma"));
    const gemmaRows = out.responses.filter((row) => row.memberId === gemma?.memberId);
    assert.ok(gemmaRows.length >= 1);
    assert.ok(gemmaRows.every((row) => row.memberId === gemma?.memberId));
    assert.ok(gemmaRows.every((row) => row.dispatchedModelId === gemma?.modelId));
    assert.equal(gemmaTries, 2);
    assert.equal(out.task.status, "COMPLETE");
  });

  it("fails one Round-1 member and still runs independent Round-2 plus synthesis fallback", async () => {
    const synthModels: string[] = [];
    const out = await runCouncil({
      creds: { ...creds, synthesizerModel: "openai/gpt-a" },
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          if (opts.model.includes("gemma") && !opts.responseFormat) {
            return {
              ok: false,
              error: "timeout",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "ROUND_1",
                httpClass: "timeout",
                errorClass: "TIMEOUT",
                retryExhausted: true,
              }),
            };
          }
          if (opts.responseFormat) {
            synthModels.push(opts.model);
            if (opts.model === "openai/gpt-a") {
              return {
                ok: false,
                error: "500",
                failure: providerFailure({
                  provider: "openrouter",
                  model: opts.model,
                  stage: "SYNTHESIS",
                  httpStatus: 500,
                  errorClass: "HTTP_ERROR",
                }),
              };
            }
            return { ok: true, completion: { ...completion(opts.model), text: artifactJson(five.map((row) => row.memberId)) } };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        yieldFn: async () => undefined,
      },
    });
    assert.equal(out.task.status, "COMPLETE");
    const r1 = out.responses.filter((row) => row.round === 1);
    assert.equal(r1.length, 5);
    assert.equal(survivingResponses(r1).length, 4);
    assert.equal(out.responses.filter((row) => row.round === 2).length, 4);
    assert.ok(synthModels[0] === "openai/gpt-a");
    assert.ok(synthModels.length >= 2);
    assert.ok(synthModels.slice(1).every((id) => id !== "unselected/premium"));
    const synth = out.responses.filter((row) => isSynthesisResponse(row));
    assert.ok(synth.some((row) => !row.error));
    assert.ok(synth.some((row) => row.error));
  });

  it("CREATE fails only after every selected survivor fails synthesis and keeps Round 1/2", async () => {
    const out = await runCouncil({
      creds: { ...creds, synthesizerModel: "openai/gpt-a" },
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          if (opts.responseFormat) {
            return {
              ok: false,
              error: "500",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "SYNTHESIS",
                httpStatus: 500,
                errorClass: "HTTP_ERROR",
              }),
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        yieldFn: async () => undefined,
      },
    });
    assert.equal(out.task.status, "FAILED");
    assert.equal(out.task.diagnostics?.run?.partial, true);
    assert.match(out.task.error ?? "", /Synthesis failed/);
    assert.equal(out.responses.filter((row) => row.round === 1 && !row.error).length, 5);
    assert.equal(out.responses.filter((row) => row.round === 2 && !row.error).length, 5);
    assert.ok(out.responses.filter((row) => isSynthesisResponse(row)).length >= 2);
    assert.equal(out.artifact, null);
  });

  it("never substitutes an unselected model", async () => {
    const seen: string[] = [];
    const out = await runCouncil({
      creds: { ...creds, synthesizerModel: "unselected/premium" },
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          seen.push(opts.model);
          if (opts.responseFormat) {
            return { ok: true, completion: { ...completion(opts.model), text: artifactJson(five.map((row) => row.memberId)) } };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        yieldFn: async () => undefined,
      },
    });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(seen.includes("unselected/premium"), false);
    assert.ok(seen.every((id) => five.some((row) => row.modelId === id)));
  });

  it("aggregates tokens and latency when cost is null", async () => {
    const out = await runCouncil({
      creds: { ...creds, members: five.slice(0, 2) },
      project: { id: "p1", name: "DEX", description: "clocks" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model, { cost: null, inputTokens: 11, outputTokens: 7, latencyMs: 9 }),
                text: artifactJson(five.slice(0, 2).map((row) => row.memberId)),
              },
            };
          }
          return { ok: true, completion: completion(opts.model, { cost: null, inputTokens: 10, outputTokens: 6, latencyMs: 8 }) };
        },
        yieldFn: async () => undefined,
      },
    });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.task.totalCostUsd, null);
    assert.ok((out.task.totalInputTokens ?? 0) >= 10);
    assert.ok((out.task.totalOutputTokens ?? 0) >= 6);
    assert.ok((out.task.totalLatencyMs ?? 0) >= 8);
    const totals = aggregateTelemetry(out.responses);
    assert.equal(totals.totalCostUsd, null);
    assert.ok((totals.totalInputTokens ?? 0) > 0);
  });

  it("names error classes instead of unknown", () => {
    assert.equal(classifyErrorClass(null, "weird").errorClass, "PROVIDER_ERROR");
    assert.equal(classifyErrorClass(408, "timed out").errorClass, "TIMEOUT");
    assert.equal(classifyErrorClass(0, "failed to fetch").errorClass, "NETWORK_ERROR");
    assert.equal(classifyErrorClass(429, "").errorClass, "RATE_LIMITED");
    assert.equal(classifyErrorClass(404, "no model", "MODEL_UNAVAILABLE").errorClass, "MODEL_UNAVAILABLE");
    const queue = synthesizerQueue(
      five.slice(0, 2).map((row) => ({
        id: row.memberId,
        taskId: "t",
        memberId: row.memberId,
        agent: row.memberId,
        role: row.role,
        round: 2 as const,
        stage: "ROUND_2" as const,
        model: row.modelId,
        dispatchedModelId: row.modelId,
        provider: "openrouter",
        promptSnapshot: "",
        responseText: "ok",
        structured: null,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        cost: null,
        requestId: null,
        latencyMs: 1,
        attempt: 1,
        error: null,
        contextManifestId: null,
        contextHash: "h",
        runId: "r",
      })),
      five.slice(0, 2),
      five[1].modelId,
    );
    assert.equal(queue[0]?.memberId, five[1].memberId);
  });

  it("does not collapse auto-assigned members onto one role identity", () => {
    const members = membersFromIds(["openai/a", "openai/b", "x-ai/c", "deepseek/d", "anthropic/e"]);
    assert.equal(members.length, 5);
    assert.equal(new Set(members.map((row) => row.memberId)).size, 5);
  });
});
