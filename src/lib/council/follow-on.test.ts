import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { t } from "../i18n/catalog.ts";
import { deriveDecisionRecord } from "./decision.ts";
import {
  createPatchPrompt,
  followOnPlan,
  freezeTexts,
  isCommandNextAction,
} from "./follow-on.ts";
import type { CouncilResult, Task } from "./types.ts";
import type { DecisionRecord } from "./decision.ts";

const storeSrc = readFileSync(fileURLToPath(new URL("./store.ts", import.meta.url)), "utf8");
const panelSrc = readFileSync(fileURLToPath(new URL("../../components/decision-record.tsx", import.meta.url)), "utf8");
const pageSrc = readFileSync(fileURLToPath(new URL("../../routes/t.$taskId.tsx", import.meta.url)), "utf8");

const source: Task = {
  id: "t-prev",
  projectId: "p1",
  title: "DEX Causal Flow Engine",
  prompt: "Reconstruct the architecture from Chat 220.",
  status: "COMPLETE",
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T01:00:00.000Z",
  totalInputTokens: null,
  totalOutputTokens: null,
  totalCostUsd: null,
  totalLatencyMs: null,
  diagnostics: null,
  selectedChatSourceIds: ["c-220"],
  selectedFileIds: ["f-repo"],
  mode: "CREATE",
  requiresHistoricalContext: true,
  candidateArtifactId: "a1",
  decisionQuestion: null,
  contextManifestId: null,
  contextHash: null,
  provider: "nanogpt",
  canonicalTaskEn: "Reconstruct the architecture from Chat 220.",
  originalTitle: "DEX Causal Flow Engine",
};

function blockedRecord(nextWhy: string): DecisionRecord {
  const result: CouncilResult = {
    taskId: source.id,
    status: "BLOCKED",
    consensus: ["Single ensemble kernel.", "Gamma-0 is a permanent challenger."],
    disagreements: [],
    blockers: ["Architecture is not yet frozen."],
    recommendation: "Create a freeze patch, then REVIEW.",
    agentPositions: {},
    synthesisRaw: "{}",
    synthesizerProposedStatus: "BLOCKED",
    finalEnforcedStatus: "BLOCKED",
    reconciledStatus: "BLOCKED",
    verdictOverride: false,
    overrideReason: null,
    decision: null,
    rationale: null,
    dissent: [],
    reviewVerdict: null,
    alternatives: [],
    evidence: [],
    risks: [],
    issues: ["Architecture presented as frozen without Chat 220 freeze."],
    proposedCorrections: ["Write the freeze patch with citations."],
    resolvedIssues: [],
    unresolvedIssues: ["Architecture is not yet frozen."],
    citations: ["[CHAT:c-220:1]"],
    failedAgents: [],
    operatorRecord: {
      summary: "Architecture reconstructed. Freeze is still open.",
      completed: ["Reconstructed the Causal Flow Engine from the selected chats."],
      notCompleted: ["Architecture is not frozen."],
      implementation: ["Repository evidence is DESIGNED_ONLY."],
      blockers: ["Chat 220 says the architecture is not yet frozen."],
      recommended: ["Create a freeze patch, then REVIEW."],
      required: ["Cited freeze artifact before ACCEPT."],
      userActions: ["Click CREATE PATCH so Council follows its next step."],
      nextStep: nextWhy,
    },
  };
  return deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result });
}

describe("follow-on CREATE PATCH", () => {
  it("turns CREATE_PATCH into a CREATE task that follows the recorded next step", () => {
    const record = blockedRecord("CREATE PATCH / freeze architecture.");
    assert.equal(record.nextAction, "CREATE_PATCH");
    const plan = followOnPlan({
      nextAction: record.nextAction,
      record,
      source,
      artifactId: "a1",
    });
    assert.equal(plan.kind, "SPAWN_TASK");
    if (plan.kind !== "SPAWN_TASK") return;
    assert.equal(plan.mode, "CREATE");
    assert.match(plan.title, /^Patch:/);
    assert.equal(plan.candidateArtifactId, "a1");
    assert.match(plan.prompt, /OPERATOR COMMAND/);
    assert.match(plan.prompt, /CREATE PATCH/);
    assert.match(plan.prompt, /follow its own next step/);
    assert.match(plan.prompt, /CREATE PATCH \/ freeze architecture/);
    assert.match(plan.prompt, /Do not claim they are already FROZEN/);
    assert.match(plan.prompt, /contract violation/);
    assert.match(plan.prompt, /Memory freeze happens only after a later ACCEPT/);
    assert.match(plan.prompt, /Chat 220 says the architecture is not yet frozen/);
    assert.equal(/status: "FROZEN"|kind: "INVARIANT"/.test(plan.prompt), false);
  });

  it("does not mint frozen invariants when the operator clicks CREATE PATCH", () => {
    const record = blockedRecord("Freeze the architecture.");
    const plan = followOnPlan({ nextAction: "CREATE_PATCH", record, source, artifactId: "a1" });
    assert.notEqual(plan.kind, "ACCEPT");
    assert.equal(plan.kind, "SPAWN_TASK");
    const prompt = createPatchPrompt(record, source);
    assert.match(prompt, /Do not invent frozen invariants without citations/);
  });

  it("RUN_REVIEW and RUN_DECIDE spawn those modes; evidence actions navigate; ACCEPT freezes consensus", () => {
    const ready: DecisionRecord = {
      ...blockedRecord("Run REVIEW."),
      verdict: "READY_FOR_REVIEW",
      nextAction: "RUN_REVIEW",
      nextActionWhy: "The reconstructed artifact is ready for a REVIEW Council.",
      blockers: [],
      blockerNotes: [],
    };
    const review = followOnPlan({ nextAction: "RUN_REVIEW", record: ready, source, artifactId: "a1" });
    assert.equal(review.kind, "SPAWN_TASK");
    if (review.kind === "SPAWN_TASK") {
      assert.equal(review.mode, "REVIEW");
      assert.equal(review.candidateArtifactId, "a1");
      assert.match(review.prompt, /Do not freeze Memory/);
    }

    const decide = followOnPlan({
      nextAction: "RUN_DECIDE",
      record: { ...ready, nextAction: "RUN_DECIDE", nextActionWhy: "Pick the kernel owner.", userActions: ["Pick the kernel owner."] },
      source: { ...source, decisionQuestion: null },
    });
    assert.equal(decide.kind, "SPAWN_TASK");
    if (decide.kind === "SPAWN_TASK") {
      assert.equal(decide.mode, "DECIDE");
      assert.equal(decide.decisionQuestion, "Pick the kernel owner.");
    }

    assert.deepEqual(followOnPlan({ nextAction: "ADD_EVIDENCE", record: ready, source }), {
      kind: "NAVIGATE",
      to: "chats",
    });
    assert.deepEqual(followOnPlan({ nextAction: "ADD_REPOSITORY_EVIDENCE", record: ready, source }), {
      kind: "NAVIGATE",
      to: "files",
    });
    assert.deepEqual(followOnPlan({ nextAction: "ACCEPT", record: ready, source }), { kind: "ACCEPT" });
    assert.deepEqual(followOnPlan({ nextAction: "NO_ACTION", record: ready, source }), { kind: "NONE" });
    assert.equal(isCommandNextAction("CREATE_PATCH"), true);
    assert.equal(isCommandNextAction("NO_ACTION"), false);
  });

  it("ACCEPT freeze texts prefer consensus and never run for CREATE_PATCH", () => {
    const record = blockedRecord("Freeze architecture.");
    const texts = freezeTexts(record, {
      consensus: ["Single ensemble kernel.", "Gamma-0 is a permanent challenger."],
      decision: "Keep Gamma-0 as challenger.",
    });
    assert.deepEqual(texts.slice(0, 2), ["Single ensemble kernel.", "Gamma-0 is a permanent challenger."]);
    assert.ok(texts.includes("Keep Gamma-0 as challenger."));
    const plan = followOnPlan({ nextAction: "CREATE_PATCH", record, source });
    assert.notEqual(plan.kind, "ACCEPT");
  });

  it("wires an active next-action button and copies prior evidence onto the follow-on CREATE", () => {
    assert.match(panelSrc, /onFollowOn\?: \(action: NextAction\) => void/);
    assert.match(panelSrc, /<PrimaryButton/);
    assert.match(panelSrc, /onFollowOn\(view\.nextAction\)/);
    assert.match(panelSrc, /t\(`follow\.\$\{view\.nextAction\}`\)/);
    assert.match(pageSrc, /executeFollowOn\(currentTask\.id, action, \{ record: decision, artifactId: artifact\?\.id \?\? null \}\)/);
    assert.match(pageSrc, /to: "\/t\/\$taskId"/);
    assert.match(pageSrc, /\/p\/\$projectId\/chats/);
    assert.match(pageSrc, /\/p\/\$projectId\/files/);
    assert.match(storeSrc, /export function executeFollowOn/);
    assert.match(storeSrc, /export function createFollowOnTask/);
    assert.match(storeSrc, /export function acceptCouncilDecision/);
    assert.match(storeSrc, /selectedChatSourceIds: \[\.\.\.source\.selectedChatSourceIds\]/);
    assert.match(storeSrc, /selectedFileIds: \[\.\.\.source\.selectedFileIds\]/);
    assert.match(storeSrc, /provider: source\.provider/);
    assert.match(storeSrc, /selectedModels: source\.selectedModels/);
    const spawnFn = storeSrc.slice(storeSrc.indexOf("export function createFollowOnTask"));
    const spawnBody = spawnFn.slice(0, spawnFn.indexOf("export function acceptCouncilDecision"));
    assert.equal(spawnBody.includes("addContext("), false);
    assert.equal(spawnBody.includes('"FROZEN"'), false);
    assert.match(storeSrc, /kind: "INVARIANT"/);
    assert.match(storeSrc, /status: "FROZEN"/);
    assert.match(storeSrc, /source: "USER"/);
    assert.match(storeSrc, /if \(record\.nextAction !== "ACCEPT"\) return \[\]/);
  });

  it("labels the command in English and Russian", () => {
    assert.equal(t("action.CREATE_PATCH", "en"), "CREATE PATCH");
    assert.equal(t("action.CREATE_PATCH", "ru"), "СОЗДАТЬ ПАТЧ");
    assert.match(t("follow.CREATE_PATCH", "en"), /not frozen yet|Nothing is frozen yet/i);
    assert.match(t("follow.CREATE_PATCH", "ru"), /не замораживается/);
    assert.match(t("follow.ACCEPT", "ru"), /инвариант/);
    assert.equal(t("follow.busy", "ru"), "Готовим следующую задачу…");
  });
});
