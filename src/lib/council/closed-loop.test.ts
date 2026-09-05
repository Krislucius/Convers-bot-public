import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { historyDidNotMintFrozen } from "./artifact.ts";
import { councilAgentFailure, failedResponses, MIN_SURVIVING_AGENTS, survivingResponses } from "./agents.ts";
import { sanitizeEvidenceLabels } from "./citations.ts";
import { evaluateProject, evaluateTask } from "./evaluate.ts";
import {
  applyPacketReview,
  buildImplementationPacket,
  handOffPacket,
  openPacketReview,
  packetHash,
  recordImplementation,
  serializePacketHandoff,
} from "./packet.ts";
import { applyGate, completeOutput, parseJson, precheckOutput } from "./protocol.ts";
import { artifactStatusForReview, councilStatusFromReview, reviewVerdictFor } from "./review.ts";
import {
  councilPreflight,
  REVIEW_CANDIDATE_MESSAGE,
  ZERO_SOURCE_MESSAGE,
} from "./task-mode.ts";
import { coverageBlocksCouncil, runEvidencePipeline } from "../evidence/pipeline.ts";
import { filterSelectedForProject } from "../history/provenance.ts";
import { normalizeAgentKey } from "./roles.ts";
import type {
  AgentResponse,
  Artifact,
  ChatSource,
  ContextItem,
  CouncilResult,
  HistoryMessage,
  ImplementationPacket,
  ProjectFile,
  Task,
} from "./types.ts";

function sampleTask(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Canonical spec",
    prompt: "Produce Canonical System Specification v1.0 from imported chats.",
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
    ...patch,
  };
}

const artifact: Artifact = {
  id: "a1",
  projectId: "p1",
  taskId: "t1",
  type: "SPECIFICATION",
  title: "Canonical System Specification v1.0",
  version: "1.0",
  content: "# Spec\nClocks stay distinct from the matching engine.",
  status: "READY_FOR_REVIEW",
  contextHash: "abc",
  evidenceLabels: [{ claim: "Clocks stay distinct", status: "EVIDENCED", citation: "[CHAT:c1:1]" }],
  createdAt: "2026-01-01T00:00:00.000Z",
};

function chat(id: string, projectId: string, body: string, extra: Partial<ChatSource> = {}): ChatSource {
  return {
    id,
    projectId,
    provider: "CHATGPT",
    title: id,
    sourceUrl: null,
    importMethod: "PASTE",
    accessStatus: "NOT_CHECKED",
    importStatus: "IMPORTED",
    rawContent: body,
    messageCount: 1,
    characterCount: body.length,
    estimatedTokenCount: Math.ceil(body.length / 4),
    contentHash: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    importedAt: "2026-01-01T00:00:00.000Z",
    lastAccessCheckAt: null,
    lastError: null,
    includeInMemory: true,
    ...extra,
  };
}

function turn(chatSourceId: string, sequence: number, content: string): HistoryMessage {
  return {
    id: `${chatSourceId}-${sequence}`,
    chatSourceId,
    sequence,
    speaker: "user",
    role: "USER",
    content,
    timestamp: null,
  };
}

function file(id: string, text: string, notes = ""): ProjectFile {
  return {
    id,
    projectId: "p1",
    filename: `${id}.md`,
    kind: "MD",
    extractedText: text,
    members: [],
    notes,
    sizeBytes: text.length,
    characterCount: text.length,
    estimatedTokens: Math.ceil(text.length / 4),
    includeInMemory: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function response(agent: string, extra: Partial<AgentResponse> = {}): AgentResponse {
  const key = normalizeAgentKey(agent);
  return {
    id: `${key}-1`,
    taskId: "t1",
    agent: key,
    round: 2,
    model: key.toLowerCase(),
    provider: "openrouter",
    promptSnapshot: "",
    responseText: extra.responseText ?? "POSITION\nok\nP0_BLOCKERS\nnone\nP1_ARCHITECTURE\nnone",
    structured: extra.structured ?? {
      POSITION: "ok",
      P0_BLOCKERS: "none",
      P1_ARCHITECTURE: "none",
      P4_IMPROVEMENTS: "style",
    },
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    cost: 0.001,
    requestId: null,
    latencyMs: 12,
    error: extra.error ?? null,
    contextManifestId: null,
    contextHash: "h",
    runId: null,
    ...extra,
  };
}

function frozen(): ContextItem[] {
  return [
    {
      id: "inv1",
      projectId: "p1",
      source: "USER",
      kind: "INVARIANT",
      content: "Clocks stay distinct from the matching engine.",
      status: "FROZEN",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}

describe("CREATE / REVIEW / DECIDE modes", () => {
  it("CREATE without a candidate is allowed", () => {
    const gate = councilPreflight({ task: sampleTask({ candidateArtifactId: null }), artifacts: [] });
    assert.equal(gate.ok, true);
    assert.equal(gate.providerCalls, 0);
  });

  it("REVIEW without a candidate is an explicit precheck error", () => {
    const gate = councilPreflight({
      task: sampleTask({ mode: "REVIEW", requiresHistoricalContext: false, selectedChatSourceIds: [], candidateArtifactId: null }),
      artifacts: [],
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, REVIEW_CANDIDATE_MESSAGE);
    const out = precheckOutput(sampleTask({ mode: "REVIEW" }), REVIEW_CANDIDATE_MESSAGE);
    assert.equal(out.packet, null);
    assert.equal(out.result, null);
    assert.equal(out.responses.length, 0);
  });

  it("DECIDE with CONFLICTED evidence cannot auto-approve", () => {
    const parsed = parseJson(`{
      "status":"APPROVED",
      "consensus":["use clock A"],
      "disagreements":["Grok wants clock B"],
      "blockers":[],
      "recommendation":"choose A",
      "agent_positions":{"gpt":"A","grok":"B","claude":"A"},
      "decision":"A",
      "alternatives":["B"],
      "rationale":"majority",
      "dissent":["Grok"],
      "evidence":[{"claim":"two clocks","status":"CONFLICTED","citation":"[CHAT:c1:1]"}],
      "risks":["split brain"],
      "citations":["[CHAT:c1:1]"]
    }`);
    assert.ok(parsed);
    const gated = applyGate(parsed!, [response("GPT"), response("GROK"), response("CLAUDE")], "DECIDE");
    assert.equal(gated.status, "USER_DECISION_REQUIRED");
  });
});

describe("one model may fail", () => {
  it("continues when two agents survive", () => {
    const rows = [response("GPT"), response("GROK"), response("CLAUDE", { error: "provider timeout", responseText: "" })];
    assert.equal(survivingResponses(rows).length, 2);
    assert.equal(failedResponses(rows).length, 1);
    assert.equal(councilAgentFailure(rows), null);
    assert.equal(MIN_SURVIVING_AGENTS, 2);
  });

  it("fails the council when only one agent survives", () => {
    const rows = [
      response("GPT", { error: "down" }),
      response("GROK", { error: "down" }),
      response("CLAUDE"),
    ];
    assert.match(councilAgentFailure(rows) ?? "", /down|failed/i);
  });
});

describe("invalid citations", () => {
  it("demotes unpacked and invented citations instead of minting truth", () => {
    const out = sanitizeEvidenceLabels(
      [
        { claim: "frozen without cite", status: "HISTORICALLY_FROZEN", citation: null },
        { claim: "unpacked", status: "EVIDENCED", citation: "[CHAT:missing:9]" },
        { claim: "ok", status: "EVIDENCED", citation: "[CHAT:c1:1]" },
      ],
      ["[CHAT:c1:1]"],
    );
    assert.equal(out.labels[0]?.status, "UNKNOWN");
    assert.equal(out.labels[1]?.status, "UNKNOWN");
    assert.equal(out.labels[2]?.status, "EVIDENCED");
    assert.ok(out.invalid.length >= 2);
    assert.equal(historyDidNotMintFrozen([{ claim: "ok", status: "HISTORICALLY_FROZEN", citation: "[CHAT:c1:1]" }]), true);
    assert.equal(historyDidNotMintFrozen([{ claim: "invented", status: "HISTORICALLY_FROZEN", citation: null }]), false);
  });
});

describe("implementation packet closed loop", () => {
  it("round-trips READY → handoff → result → REVIEW → PATCH → PASS", () => {
    const packet = buildImplementationPacket({
      project: { id: "p1", name: "DEX" },
      task: sampleTask(),
      artifact,
      result: { blockers: [], status: "APPROVED" },
      frozen: frozen(),
      packedCitations: ["[CHAT:c1:1]"],
    });
    assert.equal(packet.status, "READY");
    assert.match(packet.scope, /DEX/);
    assert.ok(packet.requirements.length > 0);
    assert.equal(packet.invariants[0], frozen()[0]?.content);
    assert.deepEqual(packet.evidenceRefs, ["[CHAT:c1:1]"]);
    assert.ok(packet.acceptanceTests.length > 0);
    assert.equal(packet.packetHash, packetHash(packet));
    const json = serializePacketHandoff(packet);
    const parsed = JSON.parse(json) as { kind: string; hash: string };
    assert.equal(parsed.kind, "CONVERSATION_BOT_IMPLEMENTATION_PACKET");
    assert.equal(parsed.hash, packet.packetHash);

    const handed = handOffPacket(packet, "2026-09-01T00:00:00.000Z");
    assert.equal(handed.status, "HANDED_OFF");
    const recorded = recordImplementation(handed, {
      status: "SUCCEEDED",
      notes: "implemented clocks",
      now: "2026-09-01T00:01:00.000Z",
    });
    assert.equal(recorded.status, "RESULT_RECORDED");
    const opened = openPacketReview(recorded, "review-1");
    assert.equal(opened.status, "REVIEW_OPEN");
    const patched = applyPacketReview(opened, "PATCH");
    assert.equal(patched.status, "READY");
    assert.equal(patched.reviewTaskId, null);

    const second = buildImplementationPacket({
      project: { id: "p1", name: "DEX" },
      task: sampleTask({ id: "t2" }),
      artifact,
      result: { blockers: [], status: "APPROVED" },
      frozen: frozen(),
      packedCitations: ["[CHAT:c1:1]"],
      parentPacketId: patched.id,
      iteration: patched.iteration + 1,
    });
    assert.equal(second.iteration, 2);
    const closed = applyPacketReview(openPacketReview(recordImplementation(handOffPacket(second), { status: "SUCCEEDED", notes: "patch" }), "review-2"), "PASS");
    assert.equal(closed.status, "CLOSED");
    const blocked = applyPacketReview(opened, "BLOCKED");
    assert.equal(blocked.status, "CLOSED");
  });

  it("maps REVIEW verdicts onto artifact status", () => {
    assert.equal(artifactStatusForReview("PASS", "APPROVED"), "APPROVED");
    assert.equal(artifactStatusForReview("PATCH", "PATCH"), "READY_FOR_REVIEW");
    assert.equal(artifactStatusForReview("BLOCKED", "BLOCKED"), "BLOCKED");
    assert.equal(councilStatusFromReview("PASS", "BLOCKED"), "APPROVED");
  });
});

describe("evaluation", () => {
  it("summarizes mode, disagreements, evidence, iterations, and later corrections", () => {
    const create = sampleTask();
    const review = sampleTask({ id: "t2", mode: "REVIEW", candidateArtifactId: "a1" });
    const createResult: CouncilResult = {
      taskId: "t1",
      status: "APPROVED",
      consensus: ["clocks"],
      disagreements: [],
      blockers: [],
      recommendation: "ship",
      agentPositions: { gpt: "yes", grok: "yes", claude: "yes" },
      synthesisRaw: "{}",
      synthesizerProposedStatus: "APPROVED",
      finalEnforcedStatus: "APPROVED",
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
      citations: ["[CHAT:c1:1]"],
      failedAgents: [],
    };
    const reviewResult: CouncilResult = {
      ...createResult,
      taskId: "t2",
      status: "PATCH",
      reviewVerdict: "PATCH",
      finalEnforcedStatus: "PATCH",
      disagreements: ["Grok wants a narrower clock"],
      citations: ["[CHAT:c1:1]", "[FILE:f1:0-20]"],
    };
    const packets: ImplementationPacket[] = [
      {
        id: "pk1",
        projectId: "p1",
        taskId: "t1",
        artifactId: "a1",
        parentPacketId: null,
        iteration: 1,
        status: "CLOSED",
        scope: "v1",
        requirements: ["clocks"],
        invariants: [],
        evidenceRefs: ["[CHAT:c1:1]"],
        acceptanceTests: ["Verify: clocks"],
        blockers: [],
        packetHash: "h1",
        handoffAt: "2026-09-01T00:00:00.000Z",
        implementationStatus: "SUCCEEDED",
        implementationNotes: "done",
        implementationRecordedAt: "2026-09-01T00:01:00.000Z",
        reviewTaskId: "t2",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "pk2",
        projectId: "p1",
        taskId: "t2",
        artifactId: "a1",
        parentPacketId: "pk1",
        iteration: 2,
        status: "READY",
        scope: "v1 patch",
        requirements: ["narrower clock"],
        invariants: [],
        evidenceRefs: ["[CHAT:c1:1]"],
        acceptanceTests: ["Verify: narrower"],
        blockers: [],
        packetHash: "h2",
        handoffAt: null,
        implementationStatus: null,
        implementationNotes: null,
        implementationRecordedAt: null,
        reviewTaskId: null,
        createdAt: "2026-09-01T00:02:00.000Z",
      },
    ];
    const row = evaluateTask({ task: review, result: reviewResult, packets, artifacts: [artifact] });
    assert.equal(row.reviewVerdict, "PATCH");
    assert.equal(row.laterCorrection, true);
    assert.equal(row.iteration, 2);
    const summary = evaluateProject({
      projectId: "p1",
      tasks: [create, review],
      results: [createResult, reviewResult],
      packets,
      artifacts: [artifact],
    });
    assert.equal(summary.patch, 1);
    assert.equal(summary.approvedOrPass, 1);
    assert.equal(summary.laterCorrections >= 1, true);
    assert.equal(reviewVerdictFor("REVIEW", reviewResult), "PATCH");
  });
});

describe("history / evidence stress", () => {
  it("processes large multi-source history without promoting ledger rows", () => {
    const ids = Array.from({ length: 8 }, (_, i) => `c${i + 1}`);
    const result = runEvidencePipeline({
      project: { id: "p1", name: "DEX", description: "clocks" },
      task: sampleTask({ selectedChatSourceIds: ids }),
      frozen: frozen(),
      chatSources: ids.map((id) => chat(id, "p1", `${id} clocks stay distinct as an isolated domain.`)),
      historyMessages: ids.map((id) => turn(id, 1, `${id} clocks stay distinct as an isolated domain.`)),
      projectFiles: [],
    });
    assert.equal(result.coverage.status, "COMPLETE");
    assert.ok(result.entries.every((row) => row.kind === "EVIDENCE"));
    assert.equal(result.pack.text.includes("## INVARIANT"), true);
  });

  it("blocks Council on stale truncated evidence", () => {
    const result = runEvidencePipeline({
      project: { id: "p1", name: "DEX", description: "clocks" },
      task: sampleTask({ selectedChatSourceIds: [], selectedFileIds: ["f1"], requiresHistoricalContext: false }),
      frozen: [],
      chatSources: [],
      historyMessages: [],
      projectFiles: [file("f1", "partial clocks\n[truncated]", "Extracted text [truncated]")],
    });
    assert.equal(result.coverage.status, "REIMPORT_REQUIRED");
    assert.ok(coverageBlocksCouncil(result.coverage));
  });

  it("CREATE with historical context and zero sources is rejected", () => {
    const gate = councilPreflight({
      task: sampleTask({ selectedChatSourceIds: [], selectedFileIds: [] }),
      artifacts: [],
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, ZERO_SOURCE_MESSAGE);
  });
});

describe("project isolation", () => {
  it("does not select chats from another project", () => {
    const sources = [chat("a1", "A", "alpha clocks"), chat("b1", "B", "beta clocks")];
    assert.deepEqual(filterSelectedForProject(["a1", "b1"], sources, "B"), ["b1"]);
  });

  it("packet SQL is user-scoped", () => {
    const src = readFileSync(fileURLToPath(new URL("./account.server.ts", import.meta.url)), "utf8");
    assert.match(src, /from implementation_packets where user_id = \$\{userId\}/);
    assert.match(src, /where implementation_packets\.user_id = \$\{userId\}/);
  });
});

describe("completeOutput preserves structured synthesis", () => {
  it("keeps positions, citations, and PATCH extras", () => {
    const parsed = parseJson(`{
      "status":"PATCH",
      "review_verdict":"PATCH",
      "consensus":["keep clocks"],
      "disagreements":["naming"],
      "blockers":[],
      "recommendation":"patch title",
      "agent_positions":{"gpt":"pass","grok":"patch","claude":"pass"},
      "issues":["title drift"],
      "proposed_corrections":["rename"],
      "resolved_issues":["p4 style"],
      "unresolved_issues":["title"],
      "citations":["[CHAT:c1:1]"]
    }`);
    assert.ok(parsed);
    const gated = applyGate(parsed!, [response("GPT"), response("GROK"), response("CLAUDE")], "REVIEW");
    assert.equal(gated.status, "PATCH");
    const out = completeOutput(sampleTask({ mode: "REVIEW", candidateArtifactId: "a1" }), [response("GPT")], parsed!, gated, {
      packedCitations: ["[CHAT:c1:1]"],
      failedAgents: [normalizeAgentKey("CLAUDE")],
    });
    assert.equal(out.result?.reviewVerdict, "PATCH");
    assert.deepEqual(out.result?.issues, ["title drift"]);
    assert.deepEqual(out.result?.proposedCorrections, ["rename"]);
    assert.ok(out.result?.citations.includes("[CHAT:c1:1]"));
    assert.deepEqual(out.result?.failedAgents, [normalizeAgentKey("CLAUDE")]);
    assert.equal(out.packet, null);
  });
});
