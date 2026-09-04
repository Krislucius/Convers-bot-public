import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { survivingResponses } from "./agents.ts";
import { runCouncil, assertRunCredentials, isStaleDisconnectError, runCredsFromReady, type CouncilProgress } from "./orchestrate.ts";
import { providerFailure } from "./provider-error.ts";
import {
  beginCouncilRun,
  isCouncilRunCurrent,
  ownedResponses,
  resetCouncilRuns,
  shouldAcceptRunWrite,
  stopCouncilRun,
} from "./run-control.ts";
import type { AgentResponse, Completion, ProviderCreds, Task } from "./types.ts";
import type { EvidencePipelineResult } from "../evidence/pipeline-cache.ts";

const creds: ProviderCreds = {
  provider: "openrouter",
  apiKey: "test-key",
  gptModel: "openai/gpt-test",
  grokModel: "x-ai/grok-test",
  claudeModel: "anthropic/claude-test",
  maxCostUsd: 5,
};

const task: Task = {
  id: "task-run",
  projectId: "p1",
  title: "Lifecycle",
  prompt: "Reconstruct the clock.",
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
  mode: "DECIDE",
  requiresHistoricalContext: false,
  candidateArtifactId: null,
  decisionQuestion: "Which clock stays?",
  contextManifestId: null,
  contextHash: null,
};

const pipeline: EvidencePipelineResult = {
  chunks: [],
  entries: [],
  coverage: {
    status: "COMPLETE",
    meaning: "COMPLETE means every selected chunk was processed.",
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

function completion(agent: string): Completion {
  return {
    text: `POSITION\n${agent} ok\nP0_BLOCKERS\nnone\nP1_ARCHITECTURE\nnone\nP2_CORRECTNESS\nnone\nP3_ROBUSTNESS\nnone\nP4_IMPROVEMENTS\nnone\nRECOMMENDATION\ngo`,
    model: agent,
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 8,
    reasoningTokens: 0,
    cost: 0.001,
    requestId: `${agent}-req`,
    latencyMs: 5,
  };
}

function hang(signal?: AbortSignal): Promise<{ ok: false; error: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "Council run stopped." });
      return;
    }
    signal?.addEventListener(
      "abort",
      () => resolve({ ok: false, error: "Council run stopped." }),
      { once: true },
    );
  });
}

function baseInput(
  extras: Partial<Parameters<typeof runCouncil>[0]> & {
    completeChat: NonNullable<Parameters<typeof runCouncil>[0]["runtime"]>["completeChat"];
    yieldFn?: () => Promise<void>;
  },
) {
  const { completeChat, yieldFn, ...rest } = extras;
  return {
    creds,
    project: { id: "p1", name: "DEX", description: "clocks" },
    context: [],
    task,
    pipeline,
    runtime: { completeChat, yieldFn: yieldFn ?? (async () => undefined) },
    ...rest,
  };
}

afterEach(() => {
  resetCouncilRuns();
});

describe("assertRunCredentials", () => {
  it("allows an empty apiKey when models are set (account-stored secret)", () => {
    assert.equal(assertRunCredentials({ ...creds, apiKey: "" }), null);
  });

  it("rejects missing models even with a stored-key empty apiKey", () => {
    const err = assertRunCredentials({ ...creds, apiKey: "", gptModel: "" });
    assert.match(err ?? "", /Choose GPT, Grok, and Claude models/);
  });

  it("rejects a pasted key that sanitizes to empty", () => {
    const err = assertRunCredentials({ ...creds, apiKey: "!!!" });
    assert.match(err ?? "", /is not connected\. Connect your API key/);
  });

  it("hides a leftover disconnect banner once the account key is ready", () => {
    assert.equal(
      isStaleDisconnectError("API is not connected. Connect your API key before running the Council.", true),
      true,
    );
    assert.equal(
      isStaleDisconnectError("OpenRouter is not connected. Connect your API key before running the Council.", true),
      true,
    );
    assert.equal(
      isStaleDisconnectError("OpenRouter is not connected. Connect your API key before running the Council.", false),
      false,
    );
  });

  it("runCredsFromReady sends an empty apiKey when the account already shows READY", () => {
    const ready = runCredsFromReady({
      ready: true,
      provider: "openrouter",
      gptModel: creds.gptModel,
      grokModel: creds.grokModel,
      claudeModel: creds.claudeModel,
      maxCostUsd: creds.maxCostUsd,
    });
    assert.equal(ready?.apiKey, "");
    assert.equal(assertRunCredentials(ready!), null);
    assert.equal(
      runCredsFromReady({
        ready: false,
        provider: "openrouter",
        gptModel: creds.gptModel,
        grokModel: creds.grokModel,
        claudeModel: creds.claudeModel,
        maxCostUsd: 1,
      }),
      null,
    );
  });
});

describe("council run lifecycle", () => {
  it("marks GPT/Grok/Claude RUNNING before any provider call returns", async () => {
    const progress: CouncilProgress[] = [];
    let inFlight = 0;
    let seenRunningBeforeReturn = false;
    const out = runCouncil(
      baseInput({
        completeChat: async (opts) => {
          inFlight += 1;
          const running = progress.some(
            (row) =>
              row.stage === "ROUND_1" &&
              row.agents?.GPT?.state === "RUNNING" &&
              row.agents.GROK?.state === "RUNNING" &&
              row.agents.CLAUDE?.state === "RUNNING",
          );
          if (running && inFlight === 3) seenRunningBeforeReturn = true;
          return { ok: true, completion: completion(opts.model) };
        },
        onProgress: (row) => progress.push(row),
      }),
    );
    const done = await out;
    assert.ok(done);
    assert.equal(progress[0]?.stage, "PREPARING");
    const round1 = progress.find((row) => row.stage === "ROUND_1");
    assert.ok(round1);
    assert.equal(round1?.agents?.GPT?.state, "RUNNING");
    assert.equal(round1?.agents?.GROK?.state, "RUNNING");
    assert.equal(round1?.agents?.CLAUDE?.state, "RUNNING");
    assert.equal(seenRunningBeforeReturn, true);
  });

  it("dispatches providers when apiKey is empty because the account holds the secret", async () => {
    let calls = 0;
    const out = await runCouncil(
      baseInput({
        creds: { ...creds, apiKey: "" },
        completeChat: async (opts) => {
          calls += 1;
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.ok(calls >= 3);
    assert.equal(out.task.error?.includes("not connected") ?? false, false);
  });

  it("Stop during PREPARING never dispatches providers", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const handle = beginCouncilRun(task.id);
    const pending = runCouncil(
      baseInput({
        runId: handle.runId,
        generation: handle.generation,
        signal: handle.signal,
        yieldFn: async () => {
          await gate;
        },
        completeChat: async () => {
          calls += 1;
          return { ok: true, completion: completion("x") };
        },
      }),
    );
    stopCouncilRun(task.id, handle.runId);
    release();
    const out = await pending;
    assert.equal(out.task.status, "CANCELLED");
    assert.equal(calls, 0);
  });

  it("Stop during a provider call preserves completed agents", async () => {
    const handle = beginCouncilRun(task.id);
    let grokStarted = () => undefined as void;
    const grokGate = new Promise<void>((resolve) => {
      grokStarted = resolve;
    });
    const pending = runCouncil(
      baseInput({
        runId: handle.runId,
        generation: handle.generation,
        signal: handle.signal,
        completeChat: async (opts) => {
          if (opts.model.includes("grok")) {
            grokStarted();
            return hang(opts.signal);
          }
          await new Promise((r) => setTimeout(r, 15));
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    await grokGate;
    await new Promise((r) => setTimeout(r, 30));
    stopCouncilRun(task.id, handle.runId);
    const out = await pending;
    assert.equal(out.task.status, "CANCELLED");
    const done = out.responses.filter((row) => !row.error && row.round === 1);
    assert.ok(done.length >= 1);
    assert.ok(done.every((row) => row.runId === handle.runId));
  });

  it("Restart issues a new run_id and ignores the late response", () => {
    const first = beginCouncilRun(task.id);
    const second = beginCouncilRun(task.id);
    assert.notEqual(first.runId, second.runId);
    assert.equal(isCouncilRunCurrent(task.id, first.runId, first.generation), false);
    assert.equal(isCouncilRunCurrent(task.id, second.runId, second.generation), true);
    const stale: AgentResponse = {
      id: "late",
      taskId: task.id,
      agent: "GPT",
      round: 1,
      model: "x",
      provider: "openrouter",
      promptSnapshot: "",
      responseText: "stale",
      structured: { __runId: first.runId },
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      cost: 0,
      requestId: null,
      latencyMs: 1,
      error: null,
      contextManifestId: null,
      contextHash: "h",
      runId: first.runId,
    };
    assert.equal(ownedResponses([stale], second.runId, first.runId).length, 0);
    assert.equal(shouldAcceptRunWrite(second.runId, first.runId), false);
  });

  it("repeated Restart clicks keep a single active run", () => {
    const a = beginCouncilRun(task.id);
    const b = beginCouncilRun(task.id);
    const c = beginCouncilRun(task.id);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, true);
    assert.equal(c.signal.aborted, false);
    assert.equal(isCouncilRunCurrent(task.id, c.runId, c.generation), true);
  });

  it("2-of-3 continues after one provider failure", async () => {
    const progress: CouncilProgress[] = [];
    const modelsCalled: string[] = [];
    await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          modelsCalled.push(opts.model);
          if (opts.model.includes("grok")) {
            return {
              ok: false,
              error: "rate",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "GROK round 1",
                httpStatus: 429,
                httpClass: "429",
                retryExhausted: true,
              }),
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
        onProgress: (row) => progress.push(row),
      }),
    );
    const round1Done = progress.find((row) => row.message === "Round 1 complete.");
    assert.ok(round1Done);
    const round1 = (round1Done?.responses ?? []).filter((row) => row.round === 1);
    assert.equal(survivingResponses(round1).length, 2);
    assert.ok(progress.some((row) => row.stage === "ROUND_2"));
  });

  it("does not start a second concurrent Council on the same task", () => {
    const first = beginCouncilRun(task.id);
    const second = beginCouncilRun(task.id);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, false);
  });
});

describe("run ownership", () => {
  it("preserves partial results from the current run_id only", () => {
    const row = (runId: string, id: string): AgentResponse => ({
      id,
      taskId: task.id,
      agent: "GPT",
      round: 1,
      model: "x",
      provider: "openrouter",
      promptSnapshot: "",
      responseText: id,
      structured: { __runId: runId },
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      cost: 0,
      requestId: null,
      latencyMs: 1,
      error: null,
      contextManifestId: null,
      contextHash: "h",
      runId,
    });
    assert.equal(ownedResponses([row("run-a", "old")], "run-b", "run-a").length, 0);
    assert.equal(ownedResponses([row("run-b", "kept")], "run-b", "run-b")[0]?.id, "kept");
  });
});
