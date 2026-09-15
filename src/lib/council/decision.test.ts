import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockerWhyIsNormalized, deriveDecisionRecord, shortTitle } from "./decision.ts";
import { applyGate, completeOutput, parseJson } from "./protocol.ts";
import type { AgentResponse, CouncilResult, Task } from "./types.ts";

function parsed(status: string, extra: Record<string, unknown> = {}) {
  const json = parseJson(
    JSON.stringify({
      status,
      consensus: ["Keep buy and sell clocks distinct.", "Event identity is canonical_event_id.", "Composer is deterministic."],
      disagreements: [],
      blockers: [],
      recommendation: "Ship the reconstructed architecture.",
      agent_positions: { gpt: "ok" },
      resolved_issues: [],
      unresolved_issues: [],
      ...extra,
    }),
  );
  assert.ok(json);
  return json!;
}

function row(agent: string, structured: Record<string, string>, round: 1 | 2 = 2): AgentResponse {
  return {
    agent,
    memberId: agent,
    round,
    stage: round === 2 ? "ROUND_2" : "ROUND_1",
    structured,
    responseText: "ok",
    error: null,
  } as AgentResponse;
}

const createTask: Task = {
  id: "t-create",
  projectId: "p1",
  title: "Spec",
  prompt: "Write the spec",
  status: "CREATED",
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  totalInputTokens: null,
  totalOutputTokens: null,
  totalCostUsd: null,
  totalLatencyMs: null,
  diagnostics: null,
  selectedChatSourceIds: ["c1"],
  selectedFileIds: [],
  mode: "CREATE",
  requiresHistoricalContext: true,
  candidateArtifactId: null,
  decisionQuestion: null,
  contextManifestId: null,
  contextHash: null,
  provider: null,
};

describe("decision record", () => {
  it("all reviewers finish but verdict BLOCKED", () => {
    const dump =
      "The candidate violates the frozen clock split invariant in every buy-side adapter, including the latent ForwardFlowForecaster path, and this entire paragraph must not appear as the blocker why.";
    const synth = parsed("APPROVED", { unresolved_issues: ["clock split invariant break"] });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: dump, REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    const out = completeOutput(createTask, [], synth, gated);
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.status, "BLOCKED");
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.runStatus, "COMPLETE");
    assert.equal(record.verdict, "BLOCKED");
    assert.equal(record.blockers.length >= 1, true);
    assert.equal(record.blockers[0]?.severity, "P0");
    assert.ok(record.blockers[0]?.issueId.startsWith("iss_"));
    assert.equal(blockerWhyIsNormalized(record), true);
    assert.equal(record.blockers.some((row) => row.why.includes("ForwardFlowForecaster")), false);
    assert.equal(record.blockers.some((row) => /this entire paragraph/i.test(row.why)), false);
    assert.equal(record.nextAction, "CREATE PATCH");
    assert.match(record.why, /Unresolved P0/);
  });

  it("P0 raised then resolved is APPROVED with the issue under RESOLVED", () => {
    const gated = applyGate(
      parsed("APPROVED", { resolved_issues: ["clock split invariant break"] }),
      [
        row("gpt", {
          P0_BLOCKERS: "clock split invariant break",
          REMAINING_P0: "none",
          REJECTED_OBJECTIONS: "none",
        }),
      ],
      "CREATE",
    );
    assert.equal(gated.status, "APPROVED");
    const out = completeOutput(createTask, [], parsed("APPROVED", { resolved_issues: ["clock split invariant break"] }), gated);
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.verdict, "APPROVED");
    assert.equal(record.blockers.length, 0);
    assert.ok(record.resolved.some((row) => /clock split/i.test(row.title)));
    assert.equal(record.nextAction, "RUN REVIEW");
    assert.match(record.why, /No unresolved blocking issues/);
  });

  it("conflicting reviewers without P0 do not BLOCK", () => {
    const gated = applyGate(
      parsed("APPROVED", { disagreements: ["Which clock owns the fill stream?"] }),
      [
        row("gpt", { P0_BLOCKERS: "none", REMAINING_P0: "none", REJECTED_OBJECTIONS: "invented invariant" }),
        row("grok", { P0_BLOCKERS: "none", REMAINING_P0: "none" }),
      ],
      "CREATE",
    );
    assert.notEqual(gated.status, "BLOCKED");
    const out = completeOutput(createTask, [], parsed("APPROVED", { disagreements: ["Which clock owns the fill stream?"] }), gated);
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.verdict, "APPROVED");
    assert.equal(record.blockers.length, 0);
    assert.equal(record.userDecisions.length, 0);
  });

  it("no blockers is APPROVED with 3–7 agreed points", () => {
    const synth = parsed("APPROVED", {
      consensus: [
        "Keep buy and sell clocks distinct.",
        "Event identity is canonical_event_id.",
        "Composer is deterministic.",
        "Surface production consumes the elasticity surface.",
      ],
    });
    const gated = applyGate(synth, [row("gpt", { P0_BLOCKERS: "none", REMAINING_P0: "none" })], "CREATE");
    const out = completeOutput(createTask, [], synth, gated);
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.verdict, "APPROVED");
    assert.equal(record.blockers.length, 0);
    assert.ok(record.agreed.length >= 3 && record.agreed.length <= 7);
    assert.equal(record.nextAction, "RUN REVIEW");
  });

  it("USER_DECISION_REQUIRED lists only operator questions", () => {
    const result = {
      taskId: "t-d",
      status: "USER_DECISION_REQUIRED",
      consensus: ["Either venue A or venue B is viable."],
      disagreements: ["Pick venue A or venue B."],
      blockers: [],
      recommendation: "Operator must choose the venue.",
      agentPositions: {},
      synthesisRaw: "{}",
      synthesizerProposedStatus: "USER_DECISION_REQUIRED",
      finalEnforcedStatus: "USER_DECISION_REQUIRED",
      proposedStatus: "USER_DECISION_REQUIRED",
      reconciledStatus: "USER_DECISION_REQUIRED",
      verdictOverride: false,
      overrideReason: null,
      decision: "Which venue is canonical?",
      rationale: "Both are evidenced.",
      dissent: [],
      reviewVerdict: null,
      alternatives: ["Venue A", "Venue B"],
      evidence: [],
      risks: [],
      issues: [],
      proposedCorrections: [],
      resolvedIssues: [],
      unresolvedIssues: [],
      citations: [],
      failedAgents: [],
    } as CouncilResult;
    const record = deriveDecisionRecord({ mode: "DECIDE", runStatus: "COMPLETE", result });
    assert.equal(record.verdict, "USER_DECISION_REQUIRED");
    assert.equal(record.nextAction, "RUN DECIDE");
    assert.ok(record.userDecisions.length >= 1);
    assert.equal(record.blockers.length, 0);
  });

  it("failed run with no semantic verdict", () => {
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "FAILED", result: null });
    assert.equal(record.runStatus, "FAILED");
    assert.equal(record.verdict, null);
    assert.equal(record.nextAction, null);
    assert.equal(record.blockers.length, 0);
    assert.match(record.conclusion, /did not finish/);
  });

  it("raw model text is never the blocker why", () => {
    assert.equal(shortTitle("clock split invariant break"), "clock split invariant break");
    const long =
      "Reviewer dump: the architecture as written cannot freeze the buy/sell clock split because the ForwardFlowForecaster still mutates shared state during fill projection and this sentence is far too long to be a why.";
    const synth = parsed("BLOCKED", { unresolved_issues: ["clock split invariant break"], blockers: [long] });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: long, REMAINING_P0: long })],
      "CREATE",
    );
    const out = completeOutput(createTask, [], synth, gated);
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.verdict, "BLOCKED");
    assert.equal(blockerWhyIsNormalized(record), true);
    for (const blocker of record.blockers) {
      assert.equal(/ForwardFlowForecaster|far too long/i.test(blocker.why), false);
      assert.ok(blocker.title.length <= 90);
    }
  });

  it("REVIEW unresolved P1 without P0 is PATCH with no open blockers", () => {
    const reviewTask: Task = { ...createTask, id: "t-review", mode: "REVIEW" };
    const gated = applyGate(
      parsed("APPROVED"),
      [
        row("gpt", {
          P0_BLOCKERS: "none",
          P1_ARCHITECTURE: "The candidate violates the frozen clock split.",
          REMAINING_P1: "clock split unresolved",
        }),
      ],
      "REVIEW",
    );
    const out = completeOutput(reviewTask, [], parsed("APPROVED"), gated);
    const record = deriveDecisionRecord({ mode: "REVIEW", runStatus: "COMPLETE", result: out.result });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(record.verdict, "PATCH");
    assert.equal(record.blockers.length, 0);
    assert.equal(record.nextAction, "CREATE PATCH");
    assert.match(record.why, /material fix/i);
  });

  it("FAILED run with leftover result has no semantic verdict", () => {
    const leftover = {
      taskId: "t-create",
      status: "BLOCKED",
      consensus: [],
      disagreements: [],
      blockers: ["clock split invariant break"],
      recommendation: "Reject.",
      agentPositions: {},
      synthesisRaw: "{}",
      synthesizerProposedStatus: "BLOCKED",
      finalEnforcedStatus: "BLOCKED",
      proposedStatus: "BLOCKED",
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
      issues: [],
      proposedCorrections: [],
      resolvedIssues: [],
      unresolvedIssues: ["clock split invariant break"],
      citations: [],
      failedAgents: [],
    } as CouncilResult;
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "FAILED", result: leftover });
    assert.equal(record.runStatus, "FAILED");
    assert.equal(record.verdict, null);
    assert.equal(record.nextAction, null);
    assert.equal(record.blockers.length, 0);
    assert.match(record.conclusion, /did not finish/);
  });
});
