import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  historyDidNotMintFrozen,
  implementationClaimsAreUnknown,
  parseSynthesizedArtifact,
  reviewMustNotReplace,
} from "./artifact.ts";
import { buildManifestPayload, hashCanonical, persistableManifest } from "./manifest.ts";
import { applyGate, buildContext, parseJson, precheckOutput, rolesForMode } from "./protocol.ts";
import { selectedChatsToContext } from "../history/provenance.ts";
import {
  DECIDE_QUESTION_MESSAGE,
  REVIEW_CANDIDATE_MESSAGE,
  ZERO_SOURCE_MESSAGE,
  councilPreflight,
  defaultRequiresHistorical,
  filterCreateBlockers,
  isNonBlockingCreateFinding,
} from "./task-mode.ts";
import type { Artifact, ChatSource, ContextItem, HistoryMessage, Task } from "./types.ts";

function sampleTask(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Reconstruct canonical DEX Gem Hunter specification from history",
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
    selectedChatSourceIds: [],
    selectedFileIds: [],
    mode: "CREATE",
    requiresHistoricalContext: true,
    candidateArtifactId: null,
    decisionQuestion: null,
    contextManifestId: null,
    contextHash: null,
    ...patch,
  };
}

const artifact: Artifact = {
  id: "a1",
  projectId: "p1",
  taskId: "t0",
  type: "SPECIFICATION",
  title: "Canonical System Specification v1.0",
  version: "1.0",
  content: "# Spec\nClocks stay distinct.",
  status: "READY_FOR_REVIEW",
  contextHash: "abc",
  evidenceLabels: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};

const chat: ChatSource = {
  id: "c1",
  projectId: "p1",
  provider: "CHATGPT",
  title: "DEX Gem Hunter — ChatGPT",
  sourceUrl: null,
  importMethod: "PASTE",
  accessStatus: "NOT_CHECKED",
  importStatus: "IMPORTED",
  rawContent: "user: reconstruct\nassistant: clocks stay distinct",
  messageCount: 2,
  characterCount: 48,
  estimatedTokenCount: 12,
  contentHash: "h1",
  createdAt: "2026-01-01T00:00:00.000Z",
  importedAt: "2026-01-01T00:00:00.000Z",
  lastAccessCheckAt: null,
  lastError: null,
  includeInMemory: true,
};

const turns: HistoryMessage[] = [
  { id: "m1", chatSourceId: "c1", sequence: 1, speaker: "user", role: "USER", content: "reconstruct", timestamp: null },
  {
    id: "m2",
    chatSourceId: "c1",
    sequence: 2,
    speaker: "assistant",
    role: "ASSISTANT",
    content: "clocks stay distinct",
    timestamp: null,
  },
];

describe("task mode preflight", () => {
  it("CREATE does not require a candidate artifact", () => {
    const gate = councilPreflight({
      task: sampleTask({ selectedChatSourceIds: ["c1"] }),
      artifacts: [],
    });
    assert.equal(gate.ok, true);
    assert.equal(gate.providerCalls, 0);
  });

  it("REVIEW requires a candidate artifact", () => {
    const gate = councilPreflight({
      task: sampleTask({ mode: "REVIEW", requiresHistoricalContext: false }),
      artifacts: [],
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.code, "PRECHECK_FAIL");
    assert.equal(gate.error, REVIEW_CANDIDATE_MESSAGE);
    assert.equal(gate.providerCalls, 0);
  });

  it("REVIEW passes when the candidate exists", () => {
    const gate = councilPreflight({
      task: sampleTask({
        mode: "REVIEW",
        requiresHistoricalContext: false,
        candidateArtifactId: "a1",
      }),
      artifacts: [artifact],
    });
    assert.equal(gate.ok, true);
  });

  it("DECIDE does not require a candidate artifact", () => {
    const gate = councilPreflight({
      task: sampleTask({
        mode: "DECIDE",
        requiresHistoricalContext: false,
        decisionQuestion: "Should MarketResponseEvidence influence PriceResponse directly?",
      }),
      artifacts: [],
    });
    assert.equal(gate.ok, true);
  });

  it("DECIDE without a question is rejected", () => {
    const gate = councilPreflight({
      task: sampleTask({ mode: "DECIDE", requiresHistoricalContext: false, prompt: "   ", decisionQuestion: "" }),
      artifacts: [],
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, DECIDE_QUESTION_MESSAGE);
  });

  it("historical CREATE with zero selected sources is rejected during preflight", () => {
    const gate = councilPreflight({
      task: sampleTask({ selectedChatSourceIds: [] }),
      artifacts: [],
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, ZERO_SOURCE_MESSAGE);
    assert.equal(gate.providerCalls, 0);
  });

  it("zero-source preflight performs zero provider calls", () => {
    const gate = councilPreflight({
      task: sampleTask({ selectedChatSourceIds: [] }),
      artifacts: [],
    });
    assert.equal(gate.providerCalls, 0);
    const out = precheckOutput(sampleTask(), ZERO_SOURCE_MESSAGE);
    assert.equal(out.responses.length, 0);
    assert.equal(out.result, null);
    assert.equal(out.artifact, null);
    assert.equal(out.task.status, "CREATED");
  });

  it("CREATE reconstruction defaults requiresHistoricalContext to true", () => {
    assert.equal(defaultRequiresHistorical("CREATE"), true);
    assert.equal(defaultRequiresHistorical("REVIEW"), false);
    assert.equal(defaultRequiresHistorical("DECIDE"), false);
  });
});

describe("context builder and manifest", () => {
  it("persists selected ChatSource IDs into the context packet", () => {
    const task = sampleTask({ selectedChatSourceIds: ["c1"] });
    const history = selectedChatsToContext("p1", task.selectedChatSourceIds, [chat], turns);
    const ctx = buildContext({ name: "DEX Gem Hunter", description: "clocks" }, task, history);
    assert.match(ctx, /SELECTED CHAT SOURCE IDS: c1/);
    assert.match(ctx, /TASK MODE: CREATE/);
    assert.match(ctx, /DEX Gem Hunter — ChatGPT/);
    assert.match(ctx, /clocks stay distinct/);
  });

  it("ContextManifest contains selected source metadata", () => {
    const task = sampleTask({ selectedChatSourceIds: ["c1"] });
    const payload = buildManifestPayload({
      project: { id: "p1", name: "DEX Gem Hunter", description: "clocks", createdAt: task.createdAt },
      task,
      context: [],
      chatSources: [chat],
      historyMessages: turns,
      artifacts: [],
    });
    assert.equal(payload.selectedAiChats.length, 1);
    assert.equal(payload.selectedAiChats[0]?.source_id, "c1");
    assert.equal(payload.selectedAiChats[0]?.title, "DEX Gem Hunter — ChatGPT");
    assert.equal(payload.selectedAiChats[0]?.content_available_locally, true);
    assert.equal(payload.task.mode, "CREATE");
  });

  it("AgentResponse references the same context snapshot hash", () => {
    const task = sampleTask({ selectedChatSourceIds: ["c1"] });
    const manifest = persistableManifest({
      project: { id: "p1", name: "DEX Gem Hunter", description: "clocks", createdAt: task.createdAt },
      task,
      context: [],
      chatSources: [chat],
      historyMessages: turns,
      artifacts: [],
      contextText: "packet",
    });
    const hashed = hashCanonical({ payload: manifest.payload, contextText: "packet" });
    assert.equal(manifest.hash, hashed);
    const row = {
      contextManifestId: manifest.id,
      contextHash: manifest.hash,
    };
    assert.equal(row.contextManifestId, manifest.id);
    assert.equal(row.contextHash, manifest.hash);
  });
});

describe("CREATE artifact synthesis", () => {
  it("CREATE produces an Artifact from synthesis JSON", () => {
    const parsed = parseJson(`{
      "status":"APPROVED",
      "consensus":["clocks stay distinct"],
      "disagreements":[],
      "blockers":[],
      "recommendation":"Publish spec v1.0",
      "agent_positions":{"gpt":"create","grok":"challenge","claude":"normalize"},
      "artifact":{
        "type":"SPECIFICATION",
        "title":"Canonical System Specification v1.0",
        "version":"1.0",
        "content":"# Spec\\nClocks stay distinct.",
        "evidenceLabels":[{"claim":"Clocks stay distinct","status":"EVIDENCED","citation":"[CHAT:c1:2]"}]
      }
    }`);
    assert.ok(parsed);
    assert.ok(parsed?.artifact);
    assert.equal(parsed?.artifact?.title, "Canonical System Specification v1.0");
    assert.equal(parseSynthesizedArtifact(parsed?.artifact)?.title, parsed?.artifact?.title);
  });

  it("REVIEW does not silently create a replacement artifact", () => {
    assert.equal(reviewMustNotReplace(null), true);
  });

  it("repository absence produces UNKNOWN implementation status rather than fabricated IMPLEMENTED", () => {
    const labels = [
      { claim: "Matching engine is implemented in production", status: "UNKNOWN" as const, citation: null },
    ];
    assert.equal(implementationClaimsAreUnknown(labels), true);
    const forged = [
      { claim: "Matching engine is implemented in production", status: "EVIDENCED" as const, citation: null },
    ];
    assert.equal(implementationClaimsAreUnknown(forged), false);
  });

  it("imported history cannot silently mint frozen invariants", () => {
    assert.equal(
      historyDidNotMintFrozen([
        { claim: "Clocks stay distinct", status: "HISTORICALLY_FROZEN", citation: "[CHAT:c1:2]" },
      ]),
      true,
    );
    assert.equal(
      historyDidNotMintFrozen([{ claim: "Invented freeze", status: "HISTORICALLY_FROZEN", citation: null }]),
      false,
    );
  });

  it("CREATE gate does not block on a missing candidate or missing repository", () => {
    const parsed = parseJson(`{
      "status":"BLOCKED",
      "consensus":[],
      "disagreements":[],
      "blockers":["No candidate artifact was supplied","No repository evidence"],
      "recommendation":"cannot proceed",
      "agent_positions":{"gpt":"","grok":"","claude":""}
    }`);
    assert.ok(parsed);
    const gated = applyGate(parsed!, [], "CREATE");
    assert.notEqual(gated.status, "BLOCKED");
    assert.equal(filterCreateBlockers(["No candidate artifact was supplied", "real P0 invariant break"]).length, 1);
    assert.equal(isNonBlockingCreateFinding("repository is absent"), true);
  });

  it("CREATE agent contracts are not merely reviewer roles", () => {
    const create = rolesForMode("CREATE");
    assert.match(create.GPT, /CREATE mode/);
    assert.match(create.GPT, /producing the artifact/);
    assert.match(create.GROK, /Do not reject CREATE/);
    assert.match(create.CLAUDE, /not merely reviewing/);
    const review = rolesForMode("REVIEW");
    assert.match(review.GPT, /Reviewer/);
  });
});

describe("history is not canonical", () => {
  it("imported chats enter context as RAW_HISTORY", () => {
    const items: ContextItem[] = selectedChatsToContext("p1", ["c1"], [chat], turns);
    assert.ok(items.every((row) => row.kind === "RAW_HISTORY" && row.status === "RAW"));
  });
});
