import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ensureMembers, type CouncilMember } from "./members.ts";
import type { Completion, ProviderCreds, Task } from "./types.ts";
import type { CouncilCompleteChat, CouncilRuntime } from "./orchestrate.ts";
import {
  DURABLE_LEASE_MS,
  OneActiveRunError,
  canClaimLease,
  completedKey,
  createMemoryDurableStore,
  emptyCursor,
  isTerminalStatus,
  shouldAcceptDurableWrite,
} from "./durable-run.ts";
import {
  driveDurableRun,
  getDurableRun,
  resetInflight,
  restartDurableRun,
  startDurableRun,
  stopDurableRun,
  tickDurableRun,
} from "./durable-engine.ts";

const members: CouncilMember[] = ensureMembers([
  { role: "LEAD_REASONER", modelId: "openai/gpt-test", label: "GPT test", family: "openai" },
  { role: "ADVERSARIAL", modelId: "x-ai/grok-test", label: "Grok test", family: "xai" },
  { role: "FORMAL_REVIEW", modelId: "anthropic/claude-test", label: "Claude test", family: "anthropic" },
]);

const creds: ProviderCreds = {
  provider: "openrouter",
  apiKey: "test-key",
  members,
  synthesizerModel: "",
  maxCostUsd: 5,
};

const task: Task = {
  id: "task-durable",
  projectId: "p1",
  title: "Durable",
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

function completion(model: string, extra = ""): Completion {
  const synth = extra.includes("SYNTH")
    ? JSON.stringify({
        status: "APPROVED",
        consensus: ["ok"],
        disagreements: [],
        blockers: [],
        recommendation: "go",
        agent_positions: {},
        decision: "keep the clock",
        rationale: "evidence holds",
        dissent: [],
        alternatives: [],
        evidence: [],
        risks: [],
      })
    : `POSITION\n${model} ok\nP0_BLOCKERS\nnone\nP1_ARCHITECTURE\nnone\nP2_CORRECTNESS\nnone\nP3_ROBUSTNESS\nnone\nP4_IMPROVEMENTS\nnone\nRECOMMENDATION\ngo`;
  return {
    text: synth,
    model,
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 8,
    reasoningTokens: 0,
    cost: 0.001,
    requestId: `${model}-req`,
    latencyMs: 5,
  };
}

function frozen() {
  return {
    project: { id: "p1", name: "DEX", description: "clocks" },
    task,
    context: [],
    chatSources: [],
    historyMessages: [],
    projectFiles: [],
    artifacts: [],
    parentPacket: null,
    members,
    synthesizerModel: "",
    maxCostUsd: 5,
    provider: creds.provider,
  };
}

function runtime(completeChat: CouncilCompleteChat, log?: string[]): CouncilRuntime {
  return {
    completeChat: async (opts) => {
      log?.push(`${opts.model}:${opts.messages[0]?.content.slice(0, 12) ?? ""}`);
      return completeChat(opts);
    },
    catalogCheck: async () => ({ ok: true, missing: [], available: members.map((row) => row.modelId) }),
    accessCheck: async () => ({ ok: true, blocked: [] }),
    now: () => "2026-09-08T05:00:00.000Z",
  };
}

afterEach(() => {
  resetInflight();
});

describe("durable write guards", () => {
  it("rejects late writes from a previous run_id, generation, or lease epoch", () => {
    const current = { runId: "run-a", generation: 2, leaseEpoch: 4 };
    assert.equal(shouldAcceptDurableWrite(current, { runId: "run-a", generation: 2, leaseEpoch: 4 }), true);
    assert.equal(shouldAcceptDurableWrite(current, { runId: "run-b", generation: 2, leaseEpoch: 4 }), false);
    assert.equal(shouldAcceptDurableWrite(current, { runId: "run-a", generation: 1, leaseEpoch: 4 }), false);
    assert.equal(shouldAcceptDurableWrite(current, { runId: "run-a", generation: 2, leaseEpoch: 3 }), false);
  });

  it("expired leases are reclaimable; live leases are not", () => {
    const row = {
      status: "ROUND_1" as const,
      cancelRequested: false,
      leaseOwner: "worker-1",
      leaseExpiresAt: 1_000,
    };
    assert.equal(canClaimLease({ ...row, leaseExpiresAt: 500 } as never, 1_000, "worker-2"), true);
    assert.equal(canClaimLease({ ...row, leaseExpiresAt: 2_000 } as never, 1_000, "worker-2"), false);
    assert.equal(canClaimLease({ ...row, leaseExpiresAt: 2_000 } as never, 1_000, "worker-1"), true);
    assert.equal(isTerminalStatus("COMPLETE"), true);
    assert.equal(completedKey("ROUND_1", "m1"), "ROUND_1:m1");
    assert.equal(emptyCursor().phase, "QUEUED");
  });
});

describe("durable server runner", () => {
  it("START returns immediately with a persisted run_id and QUEUED/PREPARING state", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    assert.ok(started.runId);
    assert.equal(started.background, true);
    assert.ok(started.status === "QUEUED" || started.status === "PREPARING");
    assert.ok(started.startedAt);
    const again = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    assert.equal(again.runId, started.runId);
  });

  it("one active Council run per task", async () => {
    const store = createMemoryDurableStore();
    await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const live = await store.getActive("u1", task.id);
    await assert.rejects(
      () => store.insert(live!),
      (err: unknown) => err instanceof OneActiveRunError,
    );
  });

  it("start → close tab → run still completes from the durable store", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const calls: string[] = [];
    const rt = runtime(async (opts) => {
      const synth = /synthesis|json_schema|CONTEXT MANIFEST/i.test(opts.messages[0]?.content ?? "") || Boolean(opts.responseFormat);
      return { ok: true, completion: completion(opts.model, synth ? "SYNTH" : "") };
    }, calls);
    const done = await driveDurableRun(store, { runId: started.runId, owner: "worker-a", runtime: rt });
    assert.equal(done?.status, "COMPLETE");
    assert.ok(done?.responses.length);
    const reconnected = await getDurableRun(store, started.runId);
    assert.equal(reconnected?.status, "COMPLETE");
    assert.equal(reconnected?.runId, started.runId);
    assert.ok(calls.length >= 7);
  });

  it("reload during Round 1 reconnects to persisted member state without new ownership", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const rt = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }));
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1_000 });
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 2_000 });
    const mid = await getDurableRun(store, started.runId);
    assert.ok(mid);
    assert.equal(mid.background, true);
    assert.ok(mid.stage === "PREPARING" || mid.stage === "ROUND_1");
    assert.ok(mid.lastProgressAt);
    const agents = Object.values(mid.agents);
    assert.ok(agents.length >= 1);
  });

  it("logout/login is reconnect: the same run_id is still visible and progressing", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const rt = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }));
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1_000 });
    const afterLogin = await store.getActive("u1", task.id);
    assert.equal(afterLogin?.runId, started.runId);
    assert.equal(isTerminalStatus(afterLogin!.status), false);
  });

  it("duplicate runner invocation is a no-op while the lease is held", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    let release = () => undefined as void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging: CouncilCompleteChat = async (opts) => {
      if (!opts.responseFormat) await gate;
      return { ok: true, completion: completion(opts.model, opts.responseFormat ? "SYNTH" : "") };
    };
    await tickDurableRun(store, {
      runId: started.runId,
      owner: "w0",
      runtime: runtime(async (opts) => ({ ok: true, completion: completion(opts.model) })),
      nowMs: 5,
      leaseMs: DURABLE_LEASE_MS,
    });
    const first = tickDurableRun(store, {
      runId: started.runId,
      owner: "w1",
      runtime: runtime(hanging),
      nowMs: 10,
      leaseMs: DURABLE_LEASE_MS,
    });
    await new Promise((r) => setTimeout(r, 20));
    const second = await tickDurableRun(store, {
      runId: started.runId,
      owner: "w2",
      runtime: runtime(async (opts) => ({ ok: true, completion: completion(opts.model) })),
      nowMs: 20,
    });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, "LEASE_HELD");
    release();
    const done = await first;
    assert.equal(done.skipped, false);
  });

  it("expired lease recovery lets another worker resume without repeating completed keys", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const calls: string[] = [];
    const rt = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }), calls);
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1_000, leaseMs: 50 });
    const after = await store.get(started.runId);
    const completed = after?.cursor.completedKeys.slice() ?? [];
    const held = await store.claimLease(started.runId, "w1", 2_000, 50);
    assert.ok(held);
    const denied = await store.claimLease(started.runId, "w2", 2_010, 50);
    assert.equal(denied, null);
    const recoveredClaim = await store.claimLease(started.runId, "w2", 2_000 + 50 + 1, 50);
    assert.ok(recoveredClaim);
    const recovered = await tickDurableRun(store, {
      runId: started.runId,
      owner: "w2",
      runtime: rt,
      nowMs: 2_060,
      leaseMs: 50,
    });
    assert.equal(recovered.skipped, false);
    const later = await store.get(started.runId);
    for (const key of completed) {
      assert.ok(later?.cursor.completedKeys.includes(key));
    }
  });

  it("interrupted provider call is retried because it was not checkpointed", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const calls: string[] = [];
    const ok = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }), calls);
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: ok, nowMs: 1 });
    const before = await store.get(started.runId);
    const keysBefore = before?.cursor.completedKeys.slice() ?? [];
    const boom: CouncilCompleteChat = async () => {
      calls.push("killed");
      throw new Error("worker killed");
    };
    const killed = await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: runtime(boom), nowMs: 2 });
    assert.equal(killed.skipped, false);
    const mid = await store.get(started.runId);
    assert.ok((mid?.cursor.completedKeys.length ?? 0) >= keysBefore.length);
    const resumeCalls = calls.length;
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: ok, nowMs: 3 });
    assert.ok(calls.length >= resumeCalls);
  });

  it("late provider response from an old run_id is discarded", async () => {
    const store = createMemoryDurableStore();
    const first = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const old = await store.get(first.runId);
    assert.ok(old);
    const restarted = await restartDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    assert.notEqual(restarted.runId, first.runId);
    const stale = await store.write(old, { generation: old.generation, leaseEpoch: old.leaseEpoch });
    assert.equal(stale, false);
    const latest = await store.get(first.runId);
    assert.equal(latest?.status, "CANCELLED");
  });

  it("STOP persists cancel even when no browser is attached", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const stopped = await stopDurableRun(store, { userId: "u1", taskId: task.id, runId: started.runId });
    assert.equal(stopped?.status, "CANCELLED");
    const tick = await tickDurableRun(store, {
      runId: started.runId,
      owner: "w1",
      runtime: runtime(async (opts) => ({ ok: true, completion: completion(opts.model) })),
      nowMs: 5,
    });
    assert.equal(tick.terminal, true);
    assert.equal(tick.public?.status, "CANCELLED");
  });

  it("RESTART cancels the old run, creates a new run_id, and keeps the old audit row", async () => {
    const store = createMemoryDurableStore();
    const first = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const rt = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }));
    await tickDurableRun(store, { runId: first.runId, owner: "w1", runtime: rt, nowMs: 1 });
    const second = await restartDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    assert.notEqual(second.runId, first.runId);
    const old = await getDurableRun(store, first.runId);
    assert.equal(old?.status, "CANCELLED");
    const active = await store.getActive("u1", task.id);
    assert.equal(active?.runId, second.runId);
  });

  it("does not repeat checkpointed provider calls on resume", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    const models: string[] = [];
    const rt = runtime(async (opts) => {
      models.push(opts.model);
      return { ok: true, completion: completion(opts.model, opts.responseFormat ? "SYNTH" : "") };
    });
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1 });
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 2 });
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 3 });
    const afterThree = models.slice();
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 4 });
    assert.equal(models.slice(0, afterThree.length).join(","), afterThree.join(","));
    assert.ok(models.length >= afterThree.length);
  });

  it("partial results stay visible after a failed run", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: task.id, frozen: frozen() });
    let n = 0;
    const rt = runtime(async (opts) => {
      n += 1;
      if (n > 2 && !opts.responseFormat) return { ok: false, error: "boom" };
      return { ok: true, completion: completion(opts.model, opts.responseFormat ? "SYNTH" : "") };
    });
    const done = await driveDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, maxTicks: 20 });
    assert.ok(done);
    assert.ok(done.status === "FAILED" || done.status === "COMPLETE");
    if (done.status === "FAILED") {
      assert.ok(done.responses.some((row) => !row.error));
      assert.equal(done.snapshot.partial, true);
    }
  });
});
