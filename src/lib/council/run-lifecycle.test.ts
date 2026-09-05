import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { survivingResponses, synthesizerAgent } from "./agents.ts";
import type { CouncilMember } from "./members.ts";
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

const members: CouncilMember[] = [
  { role: "LEAD_REASONER", modelId: "openai/gpt-test", label: "GPT test", family: "openai" },
  { role: "ADVERSARIAL", modelId: "x-ai/grok-test", label: "Grok test", family: "xai" },
  { role: "FORMAL_REVIEW", modelId: "anthropic/claude-test", label: "Claude test", family: "anthropic" },
];

const creds: ProviderCreds = {
  provider: "openrouter",
  apiKey: "test-key",
  members,
  synthesizerModel: "",
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
  provider: "openrouter",
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
    const err = assertRunCredentials({ ...creds, apiKey: "", members: [] });
    assert.match(err ?? "", /at least 2/);
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
      members: creds.members,
      synthesizerModel: "",
      maxCostUsd: creds.maxCostUsd,
    });
    assert.equal(ready?.apiKey, "");
    assert.equal(assertRunCredentials(ready!), null);
    assert.equal(
      runCredsFromReady({
        ready: false,
        provider: "openrouter",
        members: creds.members,
        synthesizerModel: "",
        maxCostUsd: 1,
      }),
      null,
    );
  });
});

describe("council run lifecycle", () => {
  it("marks selected Council models RUNNING before any provider call returns", async () => {
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
              row.agents?.LEAD_REASONER?.state === "RUNNING" &&
              row.agents.ADVERSARIAL?.state === "RUNNING" &&
              row.agents.FORMAL_REVIEW?.state === "RUNNING",
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
    assert.equal(round1?.agents?.LEAD_REASONER?.state, "RUNNING");
    assert.equal(round1?.agents?.ADVERSARIAL?.state, "RUNNING");
    assert.equal(round1?.agents?.FORMAL_REVIEW?.state, "RUNNING");
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
      agent: "LEAD_REASONER",
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
                stage: "ADVERSARIAL round 1",
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

  it("treats an empty provider response as failure, not success", async () => {
    const out = await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          if (opts.model.includes("gpt")) {
            return { ok: true, completion: { ...completion(opts.model), text: "   " } };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    const gpt = out.responses.find((row) => row.agent === "LEAD_REASONER" && row.round === 1);
    assert.ok(gpt?.error);
    assert.match(gpt?.error ?? "", /empty response/);
    assert.equal(gpt?.responseText, "");
  });

  it("keeps the exact agent, provider, and stage on timeout", async () => {
    const out = await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          if (opts.model.includes("grok")) {
            return {
              ok: false,
              error: "timeout",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "ADVERSARIAL round 1",
                httpClass: "timeout",
                retryExhausted: true,
              }),
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    const grok = out.responses.find((row) => row.agent === "ADVERSARIAL" && row.round === 1);
    assert.ok(grok?.error);
    assert.match(grok?.error ?? "", /OpenRouter/);
    assert.match(grok?.error ?? "", /ADVERSARIAL round 1/);
    assert.match(grok?.error ?? "", /timeout/);
  });

  it("does not start paid calls when a required model is unavailable", async () => {
    let calls = 0;
    const blocked = await runCouncil({
      ...baseInput({
        completeChat: async (opts) => {
          calls += 1;
          return { ok: true, completion: completion(opts.model) };
        },
      }),
      runtime: {
        completeChat: async (opts) => {
          calls += 1;
          return { ok: true, completion: completion(opts.model) };
        },
        catalogCheck: async () => ({
          ok: false,
          code: "MODEL_UNAVAILABLE" as const,
          error: "MODEL_UNAVAILABLE: missing/grok is not available on OpenRouter. Refresh models and pick a replacement in API Settings.",
          missing: ["missing/grok"],
          available: ["openai/gpt-test"],
        }),
        yieldFn: async () => undefined,
      },
    });
    assert.equal(blocked.task.status, "CREATED");
    assert.match(blocked.task.error ?? "", /MODEL_UNAVAILABLE/);
    assert.equal(blocked.responses.length, 0);
    assert.equal(calls, 0);
  });

  it("runs OpenRouter and NanoGPT as separate single-provider runs", async () => {
    const seen: string[] = [];
    const make = (provider: "openrouter" | "nanogpt") =>
      runCouncil(
        baseInput({
          creds: { ...creds, provider },
          completeChat: async (opts) => {
            seen.push(`${provider}:${opts.provider ?? "missing"}`);
            if (opts.responseFormat) {
              return {
                ok: true,
                completion: {
                  ...completion(opts.model),
                  text: JSON.stringify({
                    status: "APPROVED",
                    consensus: ["ok"],
                    disagreements: [],
                    blockers: [],
                    recommendation: "go",
                    agent_positions: { gpt: "g", grok: "k", claude: "c" },
                    decision: "keep the clock",
                    rationale: "two reviewers agree",
                    dissent: [],
                    alternatives: [],
                    evidence: [],
                    risks: [],
                  }),
                },
              };
            }
            return { ok: true, completion: completion(opts.model) };
          },
        }),
      );
    const openrouter = await make("openrouter");
    const nanogpt = await make("nanogpt");
    assert.equal(openrouter.task.provider, "openrouter");
    assert.equal(nanogpt.task.provider, "nanogpt");
    assert.ok(seen.every((row) => row.startsWith("openrouter:openrouter") || row.startsWith("nanogpt:nanogpt")));
    assert.equal(openrouter.responses.every((row) => row.provider === "openrouter"), true);
    assert.equal(nanogpt.responses.every((row) => row.provider === "nanogpt"), true);
    assert.ok(seen.some((row) => row.startsWith("openrouter:")));
    assert.ok(seen.some((row) => row.startsWith("nanogpt:")));
  });

  it("never mixes providers inside one run", async () => {
    const providers: Array<string | undefined> = [];
    await runCouncil(
      baseInput({
        creds: { ...creds, provider: "nanogpt" },
        completeChat: async (opts) => {
          providers.push(opts.provider);
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.ok(providers.length >= 3);
    assert.ok(providers.every((id) => id === "nanogpt"));
  });

  it("completes a normal CREATE in 7 successful calls", async () => {
    let calls = 0;
    const createTask: Task = { ...task, mode: "CREATE", title: "CREATE seven" };
    const out = await runCouncil(
      baseInput({
        task: createTask,
        completeChat: async (opts) => {
          calls += 1;
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "PATCH",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: ["need more evidence"],
                  recommendation: "patch",
                  agent_positions: { gpt: "g", grok: "k", claude: "c" },
                  artifact: {
                    type: "ARCHITECTURE",
                    title: "Canonical architecture",
                    version: "1.0",
                    content: "Reconstructed from selected evidence.",
                    evidenceLabels: [],
                  },
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(calls, 7);
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.responses.filter((row) => !row.error).length, 7);
  });

  it("counts retries toward the 12-attempt ceiling and still completes", async () => {
    let calls = 0;
    let grokFails = 0;
    const out = await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          calls += 1;
          if (opts.model.includes("grok") && grokFails < 2) {
            grokFails += 1;
            return {
              ok: false,
              error: "429",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "ADVERSARIAL round 1",
                httpStatus: 429,
                httpClass: "429",
              }),
            };
          }
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { gpt: "g", grok: "k", claude: "c" },
                  decision: "keep",
                  rationale: "ok",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(calls, 9);
    assert.ok(calls < 12);
    assert.equal(out.task.status, "COMPLETE");
  });

  it("stops at the 12-attempt request limit", async () => {
    const r2Fails: Record<string, number> = {};
    let calls = 0;
    const out = await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          calls += 1;
          const round2 = opts.messages.some((row) => row.content.includes("YOUR ROUND 1 POSITION"));
          if (round2) {
            const n = r2Fails[opts.model] ?? 0;
            if (n < 2) {
              r2Fails[opts.model] = n + 1;
              return {
                ok: false,
                error: "429",
                failure: providerFailure({
                  provider: "openrouter",
                  model: opts.model,
                  stage: "request",
                  httpStatus: 429,
                  httpClass: "429",
                }),
              };
            }
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.ok((out.task.error ?? "").includes("request limit") || out.responses.some((row) => (row.error ?? "").includes("request limit")));
    assert.equal(out.task.status, "FAILED");
    assert.ok(calls <= 12);
    assert.ok(calls >= 12);
  });

  it("does not use USD cost as a hard stop", async () => {
    const out = await runCouncil(
      baseInput({
        creds: { ...creds, maxCostUsd: 0.0001 },
        completeChat: async (opts) => {
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                cost: 40,
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { gpt: "g", grok: "k", claude: "c" },
                  decision: "keep",
                  rationale: "ok",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: { ...completion(opts.model), cost: 12 } };
        },
      }),
    );
    assert.equal(out.task.status, "COMPLETE");
    assert.ok((out.task.totalCostUsd ?? 0) > 0.0001);
    assert.equal((out.task.error ?? "").includes("cost limit"), false);
  });

  it("lets 2-of-3 reach synthesis", async () => {
    let synth = 0;
    const out = await runCouncil(
      baseInput({
        completeChat: async (opts) => {
          if (opts.model.includes("grok")) {
            return {
              ok: false,
              error: "timeout",
              failure: providerFailure({
                provider: "openrouter",
                model: opts.model,
                stage: "ADVERSARIAL round 1",
                httpClass: "timeout",
                retryExhausted: true,
              }),
            };
          }
          if (opts.responseFormat) {
            synth += 1;
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { gpt: "g", grok: "", claude: "c" },
                  decision: "keep",
                  rationale: "two reviewers",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(synth, 1);
    assert.equal(out.task.status, "COMPLETE");
    assert.ok(out.responses.some((row) => row.round === 3 && !row.error));
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
      agent: "LEAD_REASONER",
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

describe("dynamic council membership", () => {
  function twoMembers(): CouncilMember[] {
    return [
      { role: "LEAD_REASONER", modelId: "openai/gpt-test", label: "GPT test", family: "openai" },
      { role: "ADVERSARIAL", modelId: "deepseek/deepseek-r1", label: "R1", family: "deepseek" },
    ];
  }

  it("completes a 2-model Council with 5 successful calls", async () => {
    let calls = 0;
    const out = await runCouncil(
      baseInput({
        creds: { ...creds, members: twoMembers() },
        completeChat: async (opts) => {
          calls += 1;
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { LEAD_REASONER: "g", ADVERSARIAL: "d" },
                  decision: "keep",
                  rationale: "ok",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(calls, 5);
    assert.equal(out.task.status, "COMPLETE");
    assert.deepEqual(
      [...new Set(out.responses.map((row) => row.model))].sort(),
      ["deepseek/deepseek-r1", "openai/gpt-test"].sort(),
    );
  });

  it("completes a 5-model Council with 11 successful calls", async () => {
    const five: CouncilMember[] = [
      ...members,
      { role: "RESEARCH", modelId: "perplexity/sonar-pro", label: "Sonar", family: "perplexity" },
      { role: "ALTERNATIVE_REASONER", modelId: "moonshotai/kimi-k2", label: "Kimi", family: "kimi" },
    ];
    let calls = 0;
    const out = await runCouncil(
      baseInput({
        creds: { ...creds, members: five },
        completeChat: async (opts) => {
          calls += 1;
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: {
                    LEAD_REASONER: "a",
                    ADVERSARIAL: "b",
                    FORMAL_REVIEW: "c",
                    RESEARCH: "d",
                    ALTERNATIVE_REASONER: "e",
                  },
                  decision: "keep",
                  rationale: "ok",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(calls, 11);
    assert.equal(out.task.status, "COMPLETE");
  });

  it("blocks a selected model that disappeared from the catalog", async () => {
    let calls = 0;
    const blocked = await runCouncil({
      ...baseInput({
        completeChat: async (opts) => {
          calls += 1;
          return { ok: true, completion: completion(opts.model) };
        },
      }),
      runtime: {
        completeChat: async (opts) => {
          calls += 1;
          return { ok: true, completion: completion(opts.model) };
        },
        catalogCheck: async () => ({
          ok: false,
          code: "MODEL_UNAVAILABLE",
          error: "MODEL_UNAVAILABLE: vanished/model is not available on OpenRouter. Refresh models and pick a replacement in API Settings.",
          missing: ["vanished/model"],
          available: ["openai/gpt-test"],
        }),
        yieldFn: async () => undefined,
      },
    });
    assert.equal(blocked.task.status, "CREATED");
    assert.match(blocked.task.error ?? "", /MODEL_UNAVAILABLE/);
    assert.equal(calls, 0);
  });

  it("never synthesizes with an unselected model", async () => {
    const seen: string[] = [];
    const out = await runCouncil(
      baseInput({
        creds: { ...creds, members: twoMembers(), synthesizerModel: "unselected/premium" },
        completeChat: async (opts) => {
          seen.push(opts.model);
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                ...completion(opts.model),
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { LEAD_REASONER: "g", ADVERSARIAL: "d" },
                  decision: "keep",
                  rationale: "ok",
                  dissent: [],
                }),
              },
            };
          }
          return { ok: true, completion: completion(opts.model) };
        },
      }),
    );
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(seen.includes("unselected/premium"), false);
    assert.ok(seen.every((id) => id === "openai/gpt-test" || id === "deepseek/deepseek-r1"));
    const synth = out.responses.find((row) => row.round === 3);
    assert.ok(synth);
    assert.ok(twoMembers().some((row) => row.modelId === synth?.model || row.role === synth?.agent));
  });

  it("picks synthesis only from selected survivors", () => {
    const rows = [
      {
        id: "1",
        taskId: "t",
        agent: "LEAD_REASONER" as const,
        round: 2 as const,
        model: "openai/gpt-test",
        provider: "openrouter",
        promptSnapshot: "",
        responseText: "ok",
        structured: null,
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
        runId: "r",
      },
      {
        id: "2",
        taskId: "t",
        agent: "ADVERSARIAL" as const,
        round: 2 as const,
        model: "deepseek/deepseek-r1",
        provider: "openrouter",
        promptSnapshot: "",
        responseText: "",
        structured: null,
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cost: null,
        requestId: null,
        latencyMs: null,
        error: "timeout",
        contextManifestId: null,
        contextHash: "h",
        runId: "r",
      },
    ];
    assert.equal(synthesizerAgent(rows, twoMembers(), "unselected/premium"), "LEAD_REASONER");
    assert.equal(synthesizerAgent(rows, twoMembers(), "openai/gpt-test"), "LEAD_REASONER");
  });

  it("rejects a selected model that is not AVAILABLE on the current scan", async () => {
    let calls = 0;
    const blocked = await runCouncil({
      ...baseInput({
        completeChat: async () => {
          calls += 1;
          return { ok: true, completion: completion("openai/gpt-test") };
        },
      }),
      catalog: [
        {
          id: "openai/gpt-test",
          name: "GPT test",
          family: "openai",
          access: "AVAILABLE",
          recommendedRole: "LEAD_REASONER",
          contextTokens: 128000,
          reasoning: true,
          score: 90,
          probed: true,
        },
        {
          id: "x-ai/grok-test",
          name: "Grok test",
          family: "xai",
          access: "NOT_INCLUDED",
          recommendedRole: null,
          contextTokens: 128000,
          reasoning: true,
          score: 70,
          probed: true,
        },
        {
          id: "anthropic/claude-test",
          name: "Claude test",
          family: "anthropic",
          access: "AVAILABLE",
          recommendedRole: "FORMAL_REVIEW",
          contextTokens: 200000,
          reasoning: true,
          score: 88,
          probed: true,
        },
      ],
    });
    assert.equal(blocked.task.status, "CREATED");
    assert.match(blocked.task.error ?? "", /MODEL_UNAVAILABLE/);
    assert.match(blocked.task.error ?? "", /x-ai\/grok-test/);
    assert.equal(calls, 0);
  });
});
