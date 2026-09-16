import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ensureMembers, type CouncilMember } from "./members.ts";
import type { Completion, ProviderCreds, Task } from "./types.ts";
import type { CouncilCompleteChat, CouncilRuntime } from "./orchestrate.ts";
import {
  DURABLE_LEASE_MS,
  canClaimLease,
  createMemoryDurableStore,
  isTerminalStatus,
  toPublic,
} from "./durable-run.ts";
import {
  hasPersistedSynthesis,
  needsFinalization,
  resultVerdict,
  VERDICT_FAILED_MESSAGE,
} from "./terminal.ts";
import { driveDurableRun, resetInflight, startDurableRun, tickDurableRun } from "./durable-engine.ts";
import { TEST_PACING } from "./pacing.ts";
import { operatorKind, operatorStage, hasTaskVerdict } from "./operator-status.ts";
import { t, statusLabel, actionLabel } from "../i18n/catalog.ts";
import { localizeDecisionRecordStatic } from "../i18n/result-localize.ts";
import { deriveDecisionRecord } from "./decision.ts";
import { indexSelectedRepositories } from "../evidence/repo-index.ts";

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

function baseTask(mode: Task["mode"] = "DECIDE"): Task {
  return {
    id: `task-${mode.toLowerCase()}`,
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
    mode,
    requiresHistoricalContext: false,
    candidateArtifactId: null,
    decisionQuestion: "Which clock stays?",
    contextManifestId: null,
    contextHash: null,
    provider: "openrouter",
  };
}

function synthJson(mode: Task["mode"], extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    status: extra.status ?? (mode === "CREATE" ? "APPROVED" : "APPROVED"),
    consensus: ["ok"],
    disagreements: extra.disagreements ?? [],
    blockers: extra.blockers ?? [],
    recommendation: "go",
    agent_positions: { [members[0]!.memberId]: "ok" },
    decision: "keep the clock",
    rationale: "evidence holds",
    dissent: [],
    alternatives: [],
    evidence: [],
    risks: [],
    unresolved_issues: extra.unresolved_issues ?? [],
    resolved_issues: extra.resolved_issues ?? [],
    ...extra,
  };
  if (mode === "CREATE") {
    body.artifact = extra.artifact ?? {
      type: "SPECIFICATION",
      title: "Spec",
      version: "1.0",
      content: "# Spec",
      evidenceLabels: [{ claim: "ok", status: "UNKNOWN", citation: "" }],
    };
  }
  return JSON.stringify(body);
}

function completion(model: string, mode: Task["mode"] = "DECIDE", extra = ""): Completion {
  const text = extra.includes("SYNTH")
    ? extra.includes("BAD")
      ? "{not-json"
      : synthJson(mode)
    : `POSITION\n${model} ok\nP0_BLOCKERS\nnone\nP1_ARCHITECTURE\nnone\nP2_CORRECTNESS\nnone\nP3_ROBUSTNESS\nnone\nP4_IMPROVEMENTS\nnone\nRECOMMENDATION\ngo`;
  return {
    text,
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

function frozen(mode: Task["mode"] = "DECIDE") {
  return {
    project: { id: "p1", name: "DEX", description: "clocks" },
    task: baseTask(mode),
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

function runtime(completeChat: CouncilCompleteChat): CouncilRuntime {
  return {
    completeChat,
    catalogCheck: async () => ({ ok: true, missing: [], available: members.map((row) => row.modelId) }),
    accessCheck: async () => ({ ok: true, blocked: [] }),
    now: () => "2026-09-16T16:00:00.000Z",
    pacing: TEST_PACING,
  };
}

afterEach(() => resetInflight());

describe("lifecycle finalization", () => {
  it("normal successful Council reaches COMPLETE with a verdict", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => ({
      ok: true,
      completion: completion(opts.model, "DECIDE", opts.responseFormat ? "SYNTH" : ""),
    }));
    const done = await driveDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt });
    assert.equal(done?.status, "COMPLETE");
    assert.ok(resultVerdict(done?.output?.result));
    assert.equal(done?.background, false);
    assert.equal(done?.stallReason, null);
    assert.equal(done?.leaseExpiresAt, null);
    assert.equal(done?.snapshot.nextRecoveryDeadline, null);
    assert.equal(operatorKind({ terminal: "COMPLETE", hasVerdict: true }), "COMPLETE");
  });

  it("one model fail still completes when two survive", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => {
      if (!opts.responseFormat && opts.model.includes("grok")) {
        return { ok: false, error: "timeout" };
      }
      return { ok: true, completion: completion(opts.model, "DECIDE", opts.responseFormat ? "SYNTH" : "") };
    });
    const done = await driveDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, maxTicks: 80 });
    assert.ok(done?.status === "COMPLETE" || done?.status === "FAILED");
    if (done?.status === "COMPLETE") assert.ok(resultVerdict(done.output?.result));
  });

  it("synthesis success persists artifact and verdict for CREATE", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, {
      userId: "u1",
      taskId: "task-create",
      frozen: frozen("CREATE"),
    });
    const rt = runtime(async (opts) => ({
      ok: true,
      completion: completion(opts.model, "CREATE", opts.responseFormat ? "SYNTH" : ""),
    }));
    const done = await driveDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, maxTicks: 80 });
    assert.equal(done?.status, "COMPLETE");
    assert.ok(done?.output?.artifact);
    assert.ok(hasTaskVerdict(done?.output?.result));
    assert.equal(done?.output?.result?.status, "READY_FOR_REVIEW");
    assert.notEqual(done?.output?.result?.status, "APPROVED");
  });

  it("synthesis fail is FAILED not hanging RUNNING", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => {
      if (opts.responseFormat) return { ok: false, error: "500" };
      return { ok: true, completion: completion(opts.model) };
    });
    const done = await driveDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, maxTicks: 80 });
    assert.equal(done?.status, "FAILED");
    assert.equal(done?.background, false);
    assert.equal(operatorKind({ terminal: "FAILED", hasVerdict: false }), "ERROR");
  });

  it("synthesis persisted but terminal interrupted becomes COMPLETE on next tick", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => ({
      ok: true,
      completion: completion(opts.model, "DECIDE", opts.responseFormat ? "SYNTH" : ""),
    }));
    for (let i = 0; i < 40; i += 1) {
      const live = await store.get(started.runId);
      if (live?.cursor.phase === "SYNTHESIS" || live?.status === "SYNTHESIS") break;
      await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1_000 + i });
    }
    const mid = await store.get(started.runId);
    assert.ok(mid);
    mid.responses.push({
      id: "synth-interrupt",
      taskId: mid.taskId,
      memberId: members[0]!.memberId,
      agent: members[0]!.memberId,
      role: members[0]!.role,
      round: 3,
      stage: "SYNTHESIS",
      model: members[0]!.modelId,
      dispatchedModelId: members[0]!.modelId,
      provider: "openrouter",
      promptSnapshot: "",
      responseText: synthJson("DECIDE"),
      structured: null,
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
      cost: 0,
      requestId: "synth",
      latencyMs: 1,
      attempt: 1,
      error: null,
      contextManifestId: null,
      contextHash: null,
      runId: mid.runId,
    });
    mid.status = "SYNTHESIS";
    mid.stage = "SYNTHESIS";
    mid.output = null;
    mid.completedAt = null;
    mid.leaseOwner = null;
    mid.leaseExpiresAt = null;
    const written = await store.write(mid, { generation: mid.generation, leaseEpoch: mid.leaseEpoch });
    assert.equal(written, true);
    const interrupted = await store.get(started.runId);
    assert.ok(interrupted);
    assert.equal(interrupted.status, "SYNTHESIS");
    assert.equal(hasPersistedSynthesis(interrupted), true);
    assert.equal(
      needsFinalization({
        status: interrupted.status,
        output: interrupted.output,
        responses: interrupted.responses,
        mode: interrupted.frozenInput.task.mode,
      }),
      true,
    );
    const pub = toPublic(interrupted);
    assert.equal(pub.status, "FINALIZING");
    assert.notEqual(pub.status, "COMPLETE");
    assert.equal(pub.stallReason == null || pub.status === "FINALIZING", true);
    assert.equal(operatorStage({ stage: "FINALIZING" }), "FINALIZE");
    assert.equal(canClaimLease(interrupted, Date.now() + DURABLE_LEASE_MS, "healer"), true);
    const healed = await tickDurableRun(store, {
      runId: started.runId,
      owner: "healer",
      runtime: rt,
      nowMs: Date.now() + 10,
    });
    assert.equal(healed.public?.status, "COMPLETE");
    assert.ok(resultVerdict(healed.public?.output?.result));
    assert.equal(healed.public?.background, false);
    assert.equal(healed.public?.stallReason, null);
    assert.equal(healed.public?.leaseExpiresAt, null);
    assert.equal(healed.terminal, true);
  });

  it("COMPLETE without a verdict is healed to FAILED", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => ({ ok: true, completion: completion(opts.model) }));
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 1 });
    const row = await store.get(started.runId);
    assert.ok(row);
    row.status = "COMPLETE";
    row.stage = "COMPLETE";
    row.output = null;
    row.responses = [];
    await store.write(row, { generation: row.generation, leaseEpoch: row.leaseEpoch });
    const broken = await store.get(started.runId);
    assert.ok(broken);
    assert.equal(needsFinalization(broken), true);
    const healed = await tickDurableRun(store, { runId: started.runId, owner: "healer", runtime: rt, nowMs: 50 });
    assert.equal(healed.public?.status, "FAILED");
    assert.match(healed.public?.message ?? "", /Synthesis failed|verdict/i);
    assert.equal(operatorKind({ terminal: "COMPLETE", hasVerdict: false }), "ERROR");
    assert.notEqual(healed.public?.message, "");
  });

  it("stale lease recovery still runs after browser closed", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => ({
      ok: true,
      completion: completion(opts.model, "DECIDE", opts.responseFormat ? "SYNTH" : ""),
    }));
    const row = await store.get(started.runId);
    assert.ok(row);
    row.leaseOwner = "dead";
    row.leaseExpiresAt = 1;
    await store.write(row, { generation: row.generation, leaseEpoch: row.leaseEpoch });
    const done = await driveDurableRun(store, { runId: started.runId, owner: "sweep", runtime: rt, maxTicks: 80 });
    assert.ok(done);
    assert.ok(isTerminalStatus(done.status));
  });

  it("reload during a live run stays WORKING and does not invent COMPLETE", async () => {
    const store = createMemoryDurableStore();
    const started = await startDurableRun(store, { userId: "u1", taskId: "task-decide", frozen: frozen() });
    const rt = runtime(async (opts) => ({
      ok: true,
      completion: completion(opts.model, "DECIDE", opts.responseFormat ? "SYNTH" : ""),
    }));
    await tickDurableRun(store, { runId: started.runId, owner: "w1", runtime: rt, nowMs: 10 });
    const live = await store.get(started.runId);
    assert.ok(live);
    const pub = toPublic(live);
    assert.notEqual(pub.status, "COMPLETE");
    assert.notEqual(pub.status, "FAILED");
    assert.equal(operatorKind({ terminal: null, hasVerdict: false }), "WORKING");
    const liveStage = operatorStage({
      stage: pub.stage,
      status: pub.status,
      internalStage: pub.internalStage,
    });
    assert.ok(["PREPARE", "PROBE", "ROUND_1", "ROUND_2", "SYNTHESIS", "FINALIZE"].includes(String(liveStage)));
  });
});

describe("decision record and RU presentation", () => {
  it("resolved P0 is READY_FOR_REVIEW and unresolved P1 is not a P0 blocker", () => {
    const resolved = deriveDecisionRecord({
      mode: "CREATE",
      runStatus: "COMPLETE",
      result: {
        taskId: "t",
        status: "READY_FOR_REVIEW",
        consensus: ["done"],
        disagreements: [],
        blockers: [],
        recommendation: "review it",
        agentPositions: {},
        synthesisRaw: "{}",
        synthesizerProposedStatus: "APPROVED",
        finalEnforcedStatus: "READY_FOR_REVIEW",
        reconciledStatus: "READY_FOR_REVIEW",
        verdictOverride: true,
        overrideReason: null,
        decision: null,
        rationale: null,
        dissent: [],
        reviewVerdict: null,
        alternatives: [],
        evidence: [],
        risks: [],
        issues: [],
        proposedCorrections: [],
        resolvedIssues: ["P0 clock split is closed"],
        unresolvedIssues: ["P1 document the swap"],
        citations: [],
        failedAgents: [],
        issueLedger: {
          unresolved: [{ issueId: "P1_1", severity: "P1", text: "document the swap", source: "lead" }],
          resolved: [{ issueId: "P0_1", severity: "P0", text: "clock split is closed", source: "lead" }],
          rejected: [],
          acceptedAsPatch: [],
        },
      } as never,
      implementation: indexSelectedRepositories({ files: [] }),
    });
    assert.equal(resolved.verdict, "READY_FOR_REVIEW");
    assert.equal(resolved.blockers.length, 0);
    assert.ok(resolved.resolved.length >= 1);
  });

  it("USER_DECISION_REQUIRED stays a decision, not APPROVED", () => {
    const record = deriveDecisionRecord({
      mode: "DECIDE",
      runStatus: "COMPLETE",
      result: {
        taskId: "t",
        status: "USER_DECISION_REQUIRED",
        consensus: [],
        disagreements: ["pick one clock"],
        blockers: [],
        recommendation: "operator choice",
        agentPositions: {},
        synthesisRaw: "{}",
        synthesizerProposedStatus: "USER_DECISION_REQUIRED",
        finalEnforcedStatus: "USER_DECISION_REQUIRED",
        reconciledStatus: "USER_DECISION_REQUIRED",
        verdictOverride: false,
        overrideReason: null,
        decision: null,
        rationale: null,
        dissent: [],
        reviewVerdict: null,
        alternatives: ["inventory", "matching"],
        evidence: [],
        risks: [],
        issues: [],
        proposedCorrections: [],
        resolvedIssues: [],
        unresolvedIssues: [],
        citations: [],
        failedAgents: [],
      },
      implementation: indexSelectedRepositories({ files: [] }),
    });
    assert.equal(record.verdict, "USER_DECISION_REQUIRED");
    const ru = localizeDecisionRecordStatic(record, "ru");
    assert.equal(ru.verdict, "USER_DECISION_REQUIRED");
    assert.equal(ru.verdictLabel, "НУЖНО РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ");
    assert.equal(ru.locale, "ru");
  });

  it("RU operator chrome and next-action labels match the catalog", () => {
    assert.equal(t("operator.working", "ru"), "СОВЕТ РАБОТАЕТ");
    assert.equal(t("operator.complete", "ru"), "СОВЕТ ЗАВЕРШЁН");
    assert.equal(t("operator.stopped", "ru"), "СОВЕТ ОСТАНОВЛЕН");
    assert.equal(t("operator.error", "ru"), "ОШИБКА СОВЕТА");
    assert.equal(t("operator.round2", "ru"), "РАУНД 2");
    assert.equal(t("operator.finalize", "ru"), "ФИНАЛИЗАЦИЯ");
    assert.equal(t("operator.memberReady", "ru"), "ГОТОВО");
    assert.equal(t("operator.memberWorking", "ru"), "РАБОТАЕТ");
    assert.equal(t("operator.memberWaiting", "ru"), "ОЖИДАЕТ");
    assert.equal(statusLabel("RUNNING", "ru"), "РАБОТАЕТ");
    assert.equal(actionLabel("RUN_REVIEW", "ru"), "ЗАПУСТИТЬ REVIEW");
    assert.equal(actionLabel("CREATE_PATCH", "ru"), "СОЗДАТЬ ПАТЧ");
    assert.equal(actionLabel("RUN_DECIDE", "ru"), "ЗАПУСТИТЬ DECIDE");
    assert.equal(actionLabel("ADD_REPOSITORY_EVIDENCE", "ru"), "ДОБАВИТЬ РЕПОЗИТОРИЙ");
    assert.equal(actionLabel("ADD_EVIDENCE", "ru"), "ДОБАВИТЬ ДАННЫЕ");
    assert.equal(actionLabel("ACCEPT", "ru"), "ПРИНЯТЬ");
    assert.equal(t("fold.originalEn", "ru"), "Оригинал на английском");
    assert.equal(t("operator.verdictFailed", "ru"), "Совет завершил синтез, но не смог вынести вердикт по задаче.");
    assert.equal(t("operator.verdictFailed", "en"), VERDICT_FAILED_MESSAGE);
    const en = localizeDecisionRecordStatic(
      deriveDecisionRecord({
        mode: "CREATE",
        runStatus: "COMPLETE",
        result: {
          taskId: "t",
          status: "READY_FOR_REVIEW",
          consensus: [],
          disagreements: [],
          blockers: [],
          recommendation: "review",
          agentPositions: {},
          synthesisRaw: "{}",
          synthesizerProposedStatus: "READY_FOR_REVIEW",
          finalEnforcedStatus: "READY_FOR_REVIEW",
          reconciledStatus: "READY_FOR_REVIEW",
          verdictOverride: false,
          overrideReason: null,
          decision: null,
          rationale: null,
          dissent: [],
          reviewVerdict: null,
          alternatives: [],
          evidence: [],
          risks: [],
          issues: [],
          proposedCorrections: [],
          resolvedIssues: [],
          unresolvedIssues: [],
          citations: [],
          failedAgents: [],
        },
        implementation: indexSelectedRepositories({ files: [] }),
      }),
      "en",
    );
    const ru = localizeDecisionRecordStatic(en, "ru");
    assert.equal(en.verdict, ru.verdict);
    assert.equal(en.nextAction, ru.nextAction);
    assert.notEqual(en.locale, ru.locale);
  });
});
