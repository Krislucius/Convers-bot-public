import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyGate, completeOutput, parseJson } from "./protocol.ts";
import { decodeMemberFailure, deriveCouncilReports, reportsContainBlocked } from "./reports.ts";
import type { AgentProgress, AgentResponse, Artifact, CouncilMember, CouncilResult, Task } from "./types.ts";

function parsed(status: string, extra: Record<string, unknown> = {}) {
  const json = parseJson(
    JSON.stringify({
      status,
      consensus: ["Keep buy and sell clocks distinct."],
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

const artifact: Artifact = {
  id: "a1",
  projectId: "p1",
  taskId: "t-create",
  type: "ARCHITECTURE",
  title: "DEX Causal Flow Engine Canonical System Architecture v1",
  version: "1.0",
  content: "# spec",
  status: "READY_FOR_REVIEW",
  contextHash: "h1",
  evidenceLabels: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const qwen = "legacy_3_Qwen3_5_27B_Claude_4_6_Opus_Reasoning_Di";
const kimi = "legacy_0_moonshotai_kimi_k2_7_code";
const SCREENSHOT_NOISE = `${qwen}: none --- none ---`;

function members(): CouncilMember[] {
  return [
    { memberId: kimi, role: "LEAD_REASONER", modelId: "kimi", label: "Kimi K2", family: "kimi" },
    { memberId: qwen, role: "FORMAL_REVIEW", modelId: "qwen", label: "Qwen 3.5", family: "qwen" },
    { memberId: "legacy_1_gpt", role: "ADVERSARIAL", modelId: "gpt", label: "GPT", family: "gpt" },
    { memberId: "legacy_2_grok", role: "RESEARCH", modelId: "grok", label: "Grok", family: "grok" },
    { memberId: "legacy_4_ds", role: "ALTERNATIVE_REASONER", modelId: "ds", label: "DeepSeek", family: "deepseek" },
  ];
}

describe("member failure decoding", () => {
  it("names connection timeout unavailable empty refusal and role failures", () => {
    assert.equal(decodeMemberFailure("connect timed out").kind, "timeout");
    assert.equal(decodeMemberFailure("failed to fetch").kind, "connection");
    assert.equal(decodeMemberFailure("model unavailable", 404).kind, "unavailable");
    assert.equal(decodeMemberFailure("empty response").kind, "empty");
    assert.equal(decodeMemberFailure("I cannot assist with that request").kind, "refusal");
    assert.equal(decodeMemberFailure("wrong role for this reviewer").kind, "role");
    assert.equal(decodeMemberFailure("unauthorized", 401).kind, "auth");
  });
});

describe("dual council reports", () => {
  it("CREATE screenshot false P0 becomes accepted after A+B and never prints BLOCKED", () => {
    const synth = parsed("APPROVED", {
      blockers: [SCREENSHOT_NOISE],
      unresolved_issues: [
        "BuySellCouplingSpec ACP",
        "latent construct validation gap",
        "Shadow calibration pipeline: Not yet implemented; recommended for audited threshold adjustments",
      ],
      artifact: {
        type: "ARCHITECTURE",
        title: artifact.title,
        version: "1.0",
        content: "# reconstructed",
        evidenceLabels: [],
      },
    });
    const gated = applyGate(
      synth,
      [
        row(qwen, { P0_BLOCKERS: "none", REMAINING_P0: SCREENSHOT_NOISE, REMAINING_P1: "none" }),
        row("legacy_1_gpt", { P0_BLOCKERS: "none", REMAINING_P0: "none" }),
        row("legacy_2_grok", { P0_BLOCKERS: "none", REMAINING_P0: "none" }),
        row("legacy_4_ds", { P0_BLOCKERS: "none", REMAINING_P0: "none" }),
      ],
      "CREATE",
    );
    assert.equal(gated.status, "APPROVED");
    assert.equal(gated.blockers.length, 0);
    const out = completeOutput(createTask, [], synth, gated, { artifact, failedAgents: [kimi] });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.status, "APPROVED");
    const agents: Partial<Record<string, AgentProgress>> = {
      [kimi]: { state: "FAILED", attempt: 3, maxAttempts: 3, error: "moonshotai/kimi-k2 failed in ROUND_1: timeout class TIMEOUT attempt 3/3 (retries exhausted). No response within 120s." },
      [qwen]: { state: "DONE", attempt: 1, maxAttempts: 3, error: null },
      legacy_1_gpt: { state: "DONE", attempt: 1, maxAttempts: 3, error: null },
      legacy_2_grok: { state: "DONE", attempt: 1, maxAttempts: 3, error: null },
      legacy_4_ds: { state: "DONE", attempt: 1, maxAttempts: 3, error: null },
    };
    const reports = deriveCouncilReports({
      mode: "CREATE",
      terminal: "COMPLETE",
      taskStatus: "COMPLETE",
      result: out.result,
      artifact,
      responses: [
        { ...row(kimi, {}, 1), error: agents[kimi]?.error ?? "timeout", responseText: "" },
        row(qwen, { P0_BLOCKERS: "none", REMAINING_P0: SCREENSHOT_NOISE }),
        row("legacy_1_gpt", { P0_BLOCKERS: "none" }),
        row("legacy_2_grok", { P0_BLOCKERS: "none" }),
        row("legacy_4_ds", { P0_BLOCKERS: "none" }),
      ],
      agents,
      members: members(),
    });
    assert.equal(reports.technical.kind, "FINISHED_WITH_GAPS");
    assert.equal(reports.technical.headline, "Council finished with gaps");
    assert.equal(reports.substance.kind, "CREATED");
    assert.match(reports.substance.headline, /Created DEX Causal Flow/);
    assert.equal(reports.substance.cannotAccept.length, 0);
    assert.ok(reports.technical.members.some((row) => row.memberId === kimi && row.outcome === "failed" && row.failKind === "timeout"));
    assert.equal(reportsContainBlocked(reports), false);
    assert.equal(reportsContainBlocked(reports.technical.headline), false);
    assert.equal(reportsContainBlocked(reports.substance.headline), false);
  });

  it("all members done plus synthesis is finished successfully", () => {
    const synth = parsed("APPROVED", {
      artifact: { type: "ARCHITECTURE", title: "v1", version: "1.0", content: "# spec", evidenceLabels: [] },
    });
    const gated = applyGate(synth, [row("gpt", { P0_BLOCKERS: "none", REMAINING_P0: "none" })], "CREATE");
    const out = completeOutput(createTask, [], synth, gated, { artifact });
    const reports = deriveCouncilReports({
      mode: "CREATE",
      terminal: "COMPLETE",
      taskStatus: "COMPLETE",
      result: out.result,
      artifact,
      responses: [row("gpt", { P0_BLOCKERS: "none" })],
      agents: { gpt: { state: "DONE", attempt: 1, maxAttempts: 3, error: null } },
      members: [{ memberId: "gpt", role: "LEAD_REASONER", label: "GPT" }],
    });
    assert.equal(reports.technical.kind, "FINISHED");
    assert.equal(reports.technical.headline, "Council finished successfully");
    assert.equal(reports.substance.kind, "CREATED");
    assert.equal(reportsContainBlocked(reports), false);
  });

  it("real CREATE P0 is cannot-accept and still a finished run", () => {
    const synth = parsed("APPROVED", { unresolved_issues: ["clock split invariant break"] });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    const out = completeOutput(createTask, [], synth, gated);
    assert.equal(out.result?.status, "BLOCKED");
    const reports = deriveCouncilReports({
      mode: "CREATE",
      terminal: "COMPLETE",
      taskStatus: "COMPLETE",
      result: out.result,
      artifact: { ...artifact, status: "BLOCKED" },
      responses: [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      agents: { gpt: { state: "DONE", attempt: 1, maxAttempts: 3, error: null } },
      members: [{ memberId: "gpt", role: "LEAD_REASONER", label: "GPT" }],
    });
    assert.equal(reports.technical.kind, "FINISHED");
    assert.equal(reports.substance.kind, "CANNOT_ACCEPT");
    assert.equal(reports.substance.headline, "Cannot accept this result");
    assert.ok(reports.substance.cannotAccept.some((row) => /clock split/i.test(row)));
    assert.equal(reportsContainBlocked(reports.technical), false);
    assert.equal(reportsContainBlocked(reports.substance.headline), false);
    assert.equal(reportsContainBlocked(reports.substance.summary), false);
  });

  it("failed run without synthesis is Council failed with no task verdict", () => {
    const reports = deriveCouncilReports({
      mode: "CREATE",
      terminal: "FAILED",
      taskStatus: "FAILED",
      result: null,
      responses: [
        { ...row(kimi, {}, 1), error: "failed to fetch", responseText: "" },
        { ...row(qwen, {}, 1), error: "failed to fetch", responseText: "" },
      ],
      agents: {
        [kimi]: { state: "FAILED", attempt: 3, maxAttempts: 3, error: "failed to fetch" },
        [qwen]: { state: "FAILED", attempt: 3, maxAttempts: 3, error: "failed to fetch" },
      },
      members: members().slice(0, 2),
    });
    assert.equal(reports.technical.kind, "FAILED");
    assert.equal(reports.technical.headline, "Council failed");
    assert.equal(reports.substance.kind, "NONE");
    assert.equal(reports.substance.headline, "No task verdict yet");
    assert.ok(reports.technical.members.every((row) => row.failKind === "connection"));
    assert.equal(reportsContainBlocked(reports), false);
  });

  it("REVIEW patch is a substance needs-patch report", () => {
    const result = {
      taskId: "t-create",
      status: "PATCH",
      consensus: ["Keep clocks distinct"],
      disagreements: [],
      blockers: [],
      recommendation: "Apply the listed corrections.",
      agentPositions: {},
      synthesisRaw: "{}",
      synthesizerProposedStatus: "PATCH",
      finalEnforcedStatus: "PATCH",
      proposedStatus: "PATCH",
      reconciledStatus: "PATCH",
      verdictOverride: false,
      overrideReason: null,
      decision: null,
      rationale: null,
      dissent: [],
      reviewVerdict: "PATCH",
      alternatives: [],
      evidence: [],
      risks: [],
      issues: [],
      proposedCorrections: ["Split the clock adapter."],
      resolvedIssues: [],
      unresolvedIssues: [],
      citations: [],
      failedAgents: [],
    } as CouncilResult;
    const reports = deriveCouncilReports({
      mode: "REVIEW",
      terminal: "COMPLETE",
      taskStatus: "COMPLETE",
      result,
      members: [{ memberId: "gpt", role: "LEAD_REASONER", label: "GPT" }],
      agents: { gpt: { state: "DONE", attempt: 1, maxAttempts: 3, error: null } },
      responses: [row("gpt", { REMAINING_P1: "Split the clock adapter." })],
    });
    assert.equal(reports.technical.headline, "Council finished successfully");
    assert.equal(reports.substance.kind, "NEEDS_PATCH");
    assert.equal(reports.substance.headline, "Needs a patch to continue");
    assert.ok(reports.substance.next.some((row) => /clock adapter/i.test(row)));
    assert.equal(reportsContainBlocked(reports), false);
  });
});
