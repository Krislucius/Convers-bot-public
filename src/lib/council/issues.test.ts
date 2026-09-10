import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAgentCard } from "./agents.ts";
import { applyGate, completeOutput, parseJson } from "./protocol.ts";
import { buildIssueLedger, issueIdFor } from "./issues.ts";
import {
  canPersistArtifact,
  canPersistPacket,
  consistentFinalOutput,
  decideDurableWrite,
  exclusiveRunState,
} from "./terminal.ts";
import type { AgentResponse, Artifact, ImplementationPacket, Task } from "./types.ts";

function parsed(status: string, extra: Record<string, unknown> = {}) {
  const json = parseJson(
    JSON.stringify({
      status,
      consensus: [],
      disagreements: [],
      blockers: [],
      recommendation: "go",
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
  title: "v1",
  version: "1.0",
  content: "# spec",
  status: "READY_FOR_REVIEW",
  contextHash: "h1",
  evidenceLabels: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("issue normalization", () => {
  it("collapses duplicate P0 findings from multiple reviewers into one issue_id", () => {
    const ledger = buildIssueLedger({
      mode: "REVIEW",
      parsed: parsed("APPROVED"),
      round2: [
        row("gpt", { REMAINING_P0: "clock split is unresolved", P0_BLOCKERS: "clock split is unresolved" }),
        row("grok", { REMAINING_P0: "The clock split is unresolved.", P0_BLOCKERS: "clock split" }),
      ],
    });
    const p0 = ledger.issues.filter((item) => item.severity === "P0");
    assert.equal(p0.length, 1);
    assert.equal(p0[0]?.disposition, "UNRESOLVED");
    assert.equal(p0[0]?.issueId, issueIdFor("clock split is unresolved"));
  });

  it("empty none n/a dash lists are not unresolved issues", () => {
    const ledger = buildIssueLedger({
      mode: "REVIEW",
      parsed: parsed("APPROVED", { unresolved_issues: ["none", "n/a", "-", ""], blockers: ["none"] }),
      round2: [row("gpt", { REMAINING_P0: "none", P0_BLOCKERS: "n/a", REMAINING_P1: "-", P1_ARCHITECTURE: "none" })],
    });
    assert.equal(ledger.unresolved.length, 0);
    const gated = applyGate(parsed("APPROVED", { unresolved_issues: ["none"], blockers: ["n/a"] }), [], "REVIEW");
    assert.equal(gated.status, "APPROVED");
    assert.equal(gated.blockers.length, 0);
  });

  it("member-prefixed none --- none is not a P0 blocker", () => {
    const noise = "legacy_3_Qwen3_5_27B_Claude_4_6_Opus_Reasoning_Di: none --- none ---";
    const gated = applyGate(
      parsed("APPROVED", { blockers: [noise], unresolved_issues: [] }),
      [
        row("legacy_3_Qwen3_5_27B_Claude_4_6_Opus_Reasoning_Di", {
          P0_BLOCKERS: "none",
          REMAINING_P0: noise,
          REMAINING_P1: "none",
        }),
      ],
      "CREATE",
    );
    assert.equal(gated.status, "APPROVED");
    assert.equal(gated.blockers.length, 0);
    assert.equal(
      gated.ledger.unresolved.some((item) => /legacy_3|none --- none/i.test(item.text)),
      false,
    );
  });

  it("CREATE screenshot reconstruction unresolved list is not a P0 blocker", () => {
    const noise = "legacy_3_Qwen3_5_27B_Claude_4_6_Opus_Reasoning_Di: none --- none ---";
    const gated = applyGate(
      parsed("APPROVED", {
        blockers: [noise],
        unresolved_issues: [
          "BuySellCouplingSpec ACP",
          "latent construct validation gap",
          "Shadow calibration pipeline: Not yet implemented; recommended for audited threshold adjustments",
        ],
      }),
      [
        row("legacy_3_Qwen3_5_27B_Claude_4_6_Opus_Reasoning_Di", {
          P0_BLOCKERS: "none",
          REMAINING_P0: noise,
          REMAINING_P1: "none",
        }),
      ],
      "CREATE",
    );
    assert.equal(gated.status, "APPROVED");
    assert.equal(gated.blockers.length, 0);
    assert.equal(/\bBLOCKED\b/.test(gated.reason ?? ""), false);
  });

  it("CREATE not-yet-implemented reconstruction is not a P0 blocker", () => {
    const gated = applyGate(
      parsed("APPROVED", {
        unresolved_issues: ["Shadow calibration pipeline: Not yet implemented; recommended for audited threshold adjustments"],
        blockers: [],
      }),
      [row("gpt", { REMAINING_P0: "none", P0_BLOCKERS: "none" })],
      "CREATE",
    );
    assert.notEqual(gated.status, "BLOCKED");
    assert.equal(gated.blockers.length, 0);
  });

  it("CREATE reconstruction notes are not UNRESOLVED", () => {
    const ledger = buildIssueLedger({
      mode: "CREATE",
      parsed: parsed("APPROVED"),
      round1: [
        row(
          "alt",
          {
            P0_BLOCKERS: "none",
            P1_ARCHITECTURE: "Hierarchical Decoupling: The ForwardFlowForecaster manages the Buy-side.",
          },
          1,
        ),
      ],
      round2: [
        row("alt", {
          P0_BLOCKERS: "none",
          P1_ARCHITECTURE: "Hierarchical Decoupling: The ForwardFlowForecaster manages the Buy-side.",
          REMAINING_P0: "none",
          REMAINING_P1: "Hierarchical Decoupling: The ForwardFlowForecaster manages the Buy-side.",
        }),
      ],
    });
    assert.equal(ledger.unresolved.some((item) => item.severity === "P1"), false);
    assert.ok(ledger.resolved.some((item) => /Hierarchical Decoupling/i.test(item.text)));
  });
});

describe("final verdict reconciliation", () => {
  it("P0 raised then resolved is not BLOCKED", () => {
    const synth = parsed("APPROVED", { resolved_issues: ["clock split invariant break"], unresolved_issues: [] });
    const gated = applyGate(
      synth,
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
    assert.equal(gated.reconciledStatus, "APPROVED");
    assert.equal(gated.proposedStatus, "APPROVED");
    assert.equal(gated.blockers.length, 0);
    assert.ok(gated.ledger.resolved.some((item) => /clock split/i.test(item.text)));
  });

  it("P0 raised and unresolved is BLOCKED even if synthesizer says APPROVED", () => {
    const synth = parsed("APPROVED", {
      unresolved_issues: ["clock split invariant break"],
      artifact: { type: "ARCHITECTURE", title: "v1", version: "1.0", content: "# spec", evidenceLabels: [] },
    });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    assert.equal(gated.status, "BLOCKED");
    assert.equal(gated.proposedStatus, "APPROVED");
    assert.equal(gated.reconciledStatus, "BLOCKED");
    assert.ok(gated.blockers.some((item) => /clock split/i.test(item)));
    assert.notEqual(gated.reconciledStatus, "APPROVED");
  });

  it("reviewer objection rejected is not a blocker", () => {
    const gated = applyGate(
      parsed("APPROVED"),
      [
        row("gpt", {
          P0_BLOCKERS: "invented invariant",
          REMAINING_P0: "none",
          REJECTED_OBJECTIONS: "invented invariant",
        }),
      ],
      "REVIEW",
    );
    assert.notEqual(gated.status, "BLOCKED");
    assert.ok(gated.ledger.rejected.some((item) => /invented invariant/i.test(item.text)));
  });

  it("Round 1 P1 later Round 2 remaining none is not BLOCKED", () => {
    const gated = applyGate(
      parsed("APPROVED", { resolved_issues: ["clock split"] }),
      [
        row("gpt", { P0_BLOCKERS: "none", P1_ARCHITECTURE: "The candidate violates the frozen clock split." }, 1),
        row(
          "gpt",
          {
            P0_BLOCKERS: "none",
            P1_ARCHITECTURE: "The candidate violates the frozen clock split.",
            REMAINING_P0: "none",
            REMAINING_P1: "none",
            REJECTED_OBJECTIONS: "none",
          },
          2,
        ),
      ],
      "REVIEW",
    );
    assert.notEqual(gated.status, "BLOCKED");
    assert.equal(gated.blockers.length, 0);
    assert.ok(gated.ledger.resolved.some((item) => /clock split/i.test(item.text)));
  });

  it("CREATE reconstruction-only P1 stays APPROVED if synthesizer APPROVED", () => {
    const synth = parsed("APPROVED", {
      artifact: { type: "ARCHITECTURE", title: "v1", version: "1.0", content: "# reconstructed", evidenceLabels: [] },
    });
    const gated = applyGate(
      synth,
      [
        row("alt", {
          P0_BLOCKERS: "none",
          P1_ARCHITECTURE: "Hierarchical Decoupling: The ForwardFlowForecaster manages the Buy-side.",
          REMAINING_P0: "none",
          REMAINING_P1: "none",
        }),
      ],
      "CREATE",
    );
    assert.equal(gated.status, "APPROVED");
    assert.equal(gated.reason, null);
    assert.equal(gated.blockers.length, 0);
  });

  it("CREATE proposed BLOCKED/PATCH with no unresolved P0/P1 becomes APPROVED", () => {
    const blocked = applyGate(parsed("BLOCKED", { blockers: ["none"] }), [], "CREATE");
    assert.equal(blocked.status, "APPROVED");
    const patch = applyGate(parsed("PATCH"), [], "CREATE");
    assert.equal(patch.status, "APPROVED");
  });

  it("REVIEW real P0/P1 still blocks", () => {
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
    assert.equal(gated.status, "BLOCKED");
    assert.match(gated.reason ?? "", /P1/);
  });

  it("blockers exclude resolved issues", () => {
    const gated = applyGate(
      parsed("BLOCKED", {
        blockers: ["clock split"],
        resolved_issues: ["clock split"],
        unresolved_issues: [],
      }),
      [row("gpt", { P0_BLOCKERS: "clock split", REMAINING_P0: "none" })],
      "REVIEW",
    );
    assert.equal(gated.blockers.some((item) => /clock split/i.test(item)), false);
    assert.notEqual(gated.status, "BLOCKED");
  });

  it("one model DONE is not a Council APPROVED verdict", () => {
    const gated = applyGate(
      parsed("BLOCKED", { unresolved_issues: ["clock split invariant break"] }),
      [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    const card = formatAgentCard("GPT", { state: "DONE", attempt: 1, maxAttempts: 3, error: null });
    assert.equal(card.status, "DONE");
    assert.notEqual(card.status, "APPROVED");
    assert.equal(gated.status, "BLOCKED");
    assert.notEqual(gated.reconciledStatus, "DONE");
    assert.notEqual(gated.status, "COMPLETE");
  });
});

describe("terminal run state is singular", () => {
  it("synthesis COMPLETE cannot coexist with CANCELLED", () => {
    assert.equal(
      exclusiveRunState({
        status: "CANCELLED",
        snapshotStatus: "CANCELLED",
        hasSynthesis: true,
        result: { status: "APPROVED" } as never,
      }),
      "COMPLETE",
    );
    assert.equal(exclusiveRunState({ status: "COMPLETE", snapshotStatus: "CANCELLED" }), "COMPLETE");
    assert.equal(exclusiveRunState({ status: "CANCELLED", hasSynthesis: false }), "CANCELLED");
    assert.equal(exclusiveRunState({ status: "FAILED", hasSynthesis: false }), "FAILED");
  });

  it("COMPLETE cannot coexist with FAILED or RUNNING", () => {
    assert.equal(exclusiveRunState({ status: "COMPLETE", snapshotStatus: "FAILED" }), "COMPLETE");
    assert.equal(exclusiveRunState({ status: "RUNNING", taskStatus: "COMPLETE" }), "COMPLETE");
    assert.equal(exclusiveRunState({ status: "COUNCIL_ROUND_2", snapshotStatus: "COMPLETE" }), "COMPLETE");
    assert.equal(exclusiveRunState({ status: "FAILED", snapshotStatus: "CANCELLED" }), "FAILED");
    assert.notEqual(exclusiveRunState({ status: "COMPLETE", snapshotStatus: "FAILED" }), "FAILED");
  });

  it("contradictory COMPLETE run + BLOCKED verdict stays two fields", () => {
    const synth = parsed("APPROVED", { unresolved_issues: ["clock split invariant break"] });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    const out = completeOutput(createTask, [], synth, gated, { artifact });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.status, "BLOCKED");
    assert.notEqual(out.task.status, out.result?.status);
    assert.equal(out.packet, null);
    const view = consistentFinalOutput(out);
    assert.equal(view.ok, true);
    assert.equal(view.terminal, "COMPLETE");
  });

  it("completeOutput records proposed vs reconciled and COMPLETE execution status", () => {
    const synth = parsed("APPROVED", { unresolved_issues: ["clock split invariant break"] });
    const gated = applyGate(
      synth,
      [row("gpt", { P0_BLOCKERS: "clock split invariant break", REMAINING_P0: "clock split invariant break" })],
      "CREATE",
    );
    const out = completeOutput(createTask, [], synth, gated);
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.proposedStatus, "APPROVED");
    assert.equal(out.result?.reconciledStatus, "BLOCKED");
    assert.equal(out.result?.status, "BLOCKED");
    assert.notEqual(out.task.status, out.result?.status);
    assert.equal(out.packet, null);
  });

  it("artifact creation requires COMPLETE synthesis state", () => {
    const synth = parsed("APPROVED", {
      artifact: { type: "ARCHITECTURE", title: "v1", version: "1.0", content: "# spec", evidenceLabels: [] },
    });
    const gated = applyGate(synth, [], "CREATE");
    const packet = {
      id: "pkt",
      projectId: "p1",
      taskId: "t-create",
      artifactId: "a1",
      parentPacketId: null,
      iteration: 1,
      status: "READY",
      scope: "scope",
      requirements: [],
      invariants: [],
      evidenceRefs: [],
      acceptanceTests: [],
      blockers: ["stale"],
      packetHash: "h",
      handoffAt: null,
      implementationStatus: null,
      implementationNotes: null,
      implementationRecordedAt: null,
      reviewTaskId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as ImplementationPacket;
    const out = completeOutput(createTask, [], synth, gated, { artifact, packet });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.status, "APPROVED");
    assert.ok(out.artifact);
    assert.ok(out.packet);
    assert.deepEqual(out.packet?.blockers, []);
    assert.equal(canPersistArtifact("COMPLETE"), true);
    assert.equal(canPersistArtifact("CANCELLED"), false);
    assert.equal(canPersistArtifact("FAILED"), false);
    assert.equal(canPersistPacket("COMPLETE", "APPROVED"), true);
    assert.equal(canPersistPacket("COMPLETE", "BLOCKED"), false);
    assert.equal(canPersistPacket("CANCELLED", "APPROVED"), false);
    assert.equal(consistentFinalOutput(out).ok, true);
    assert.equal(consistentFinalOutput({ ...out, task: { ...out.task, status: "CANCELLED" } }).ok, false);
  });

  it("snapshot / packet / result blockers match the final unresolved set", () => {
    const synth = parsed("BLOCKED", { blockers: ["clock split", "resolved leftover"], resolved_issues: ["resolved leftover"] });
    const gated = applyGate(
      synth,
      [
        row("gpt", {
          P0_BLOCKERS: "clock split",
          REMAINING_P0: "clock split",
        }),
      ],
      "REVIEW",
    );
    const out = completeOutput(createTask, [], synth, gated);
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.result?.status, "BLOCKED");
    assert.deepEqual(out.result?.blockers, gated.blockers);
    assert.equal(out.result?.unresolvedIssues.some((item) => /clock split/i.test(item)), true);
    assert.equal(out.result?.blockers.some((item) => /resolved leftover/i.test(item)), false);
    assert.equal(out.packet, null);
  });

  it("COMPLETE synthesis write cannot be replaced by RUNNING or CANCELLED", () => {
    const keep = decideDurableWrite({
      currentRunId: "r1",
      incomingRunId: "r1",
      currentGeneration: 3,
      currentLeaseEpoch: 4,
      expectedGeneration: 3,
      expectedLeaseEpoch: 4,
      currentStatus: "COMPLETE",
      incomingStatus: "CANCELLED",
      currentHasSynthesis: true,
      incomingHasSynthesis: false,
    });
    assert.equal(keep, "KEEP_CURRENT");
    assert.equal(
      decideDurableWrite({
        currentRunId: "r1",
        incomingRunId: "r1",
        currentGeneration: 3,
        currentLeaseEpoch: 4,
        expectedGeneration: 3,
        expectedLeaseEpoch: 4,
        currentStatus: "COMPLETE",
        incomingStatus: "ROUND_2",
        currentHasSynthesis: true,
        incomingHasSynthesis: false,
      }),
      "KEEP_CURRENT",
    );
    assert.equal(
      decideDurableWrite({
        currentRunId: "r1",
        incomingRunId: "r1",
        currentGeneration: 2,
        currentLeaseEpoch: 2,
        expectedGeneration: 1,
        expectedLeaseEpoch: 1,
        currentStatus: "CANCELLED",
        incomingStatus: "COMPLETE",
        currentHasSynthesis: false,
        incomingHasSynthesis: true,
      }),
      "ACCEPT",
    );
  });
});
