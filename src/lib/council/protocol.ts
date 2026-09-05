import type {
  AgentKey,
  AgentResponse,
  Artifact,
  ChatMessage,
  Completion,
  ContextItem,
  ContextManifest,
  CouncilResult,
  CouncilStatus,
  EvidenceLabel,
  ProjectFile,
  ProviderCreds,
  ProviderId,
  ReviewVerdict,
  RunCouncilOutput,
  Task,
  TaskMode,
} from "./types.ts";
import { filterCreateBlockers, normalizeTaskMode } from "./task-mode.ts";
import { parseSynthesizedArtifact, parseEvidenceLabels } from "./artifact.ts";
import { asReviewVerdict, reviewVerdictFromStatus } from "./review.ts";
import { buildMandatoryContext } from "../evidence/pack.ts";
import { CURRENT_CONTEXT_TOKEN_LIMIT } from "../architecture/contracts.ts";
import { countTokens } from "../evidence/tokens.ts";
import { DEFAULT_ROLES, normalizeAgentKey, rolePrompt, type CouncilRole } from "./roles.ts";
import type { CouncilMember } from "./members.ts";
import { expectedSuccessfulCalls } from "./members.ts";

export const AGENTS: AgentKey[] = [...DEFAULT_ROLES];

export const HEADINGS = [
  "POSITION",
  "P0_BLOCKERS",
  "P1_ARCHITECTURE",
  "P2_CORRECTNESS",
  "P3_ROBUSTNESS",
  "P4_IMPROVEMENTS",
  "RECOMMENDATION",
  "ACCEPTED_OBJECTIONS",
  "REJECTED_OBJECTIONS",
  "REMAINING_P0",
  "REMAINING_P1",
  "REVISED_POSITION",
] as const;

export function rolesForMode(
  mode: TaskMode | string | null | undefined,
  agents: AgentKey[] = AGENTS,
): Record<string, string> {
  const resolved = normalizeTaskMode(mode);
  return Object.fromEntries(agents.map((role) => [role, rolePrompt(role, resolved)]));
}

export const ROUND2 = `ROUND 2 — Cross review.
You previously produced an independent Round 1 analysis. You now see the other
Council positions with explicit attribution.

Return EXACTLY these headings:
POSITION
ACCEPTED_OBJECTIONS
REJECTED_OBJECTIONS
REMAINING_P0
REMAINING_P1
P0_BLOCKERS
P1_ARCHITECTURE
P2_CORRECTNESS
P3_ROBUSTNESS
P4_IMPROVEMENTS
REVISED_POSITION
RECOMMENDATION

If a section has no items write "none".`;

function agentPositionSchema(roles: AgentKey[]) {
  const properties = Object.fromEntries(roles.map((role) => [role, { type: "string" }]));
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: roles,
  };
}

function positionsPrompt(roles: AgentKey[]): string {
  const body = roles.map((role) => `"${role}":""`).join(",");
  return `"agent_positions":{${body}}`;
}

export function reviewSynthesisPrompt(roles: AgentKey[] = AGENTS): string {
  return `You are the council synthesizer. Output a single JSON object matching:
{"status":"APPROVED|PATCH|BLOCKED|USER_DECISION_REQUIRED","review_verdict":"PASS|PATCH|BLOCKED","consensus":[],"disagreements":[],"blockers":[],"recommendation":"",${positionsPrompt(roles)},"issues":[],"proposed_corrections":[],"resolved_issues":[],"unresolved_issues":[],"citations":[]}
REVIEW: PASS = candidate is acceptable, PATCH = issues with proposed corrections, BLOCKED = P0/P1. Preserve each model position, disagreements, and citations. Any substantiated P0 or unresolved P1 => BLOCKED. P4 never blocks. Use only the selected Council roles as keys in agent_positions.`;
}

export function createSynthesisPrompt(roles: AgentKey[] = AGENTS): string {
  return `You are the CREATE-mode artifact synthesizer.
The Council's job is to PRODUCE the requested canonical artifact from TASK + CONTEXT MANIFEST + ROUND 1 + ROUND 2.
Absence of a pre-existing candidate is not a blocker.
No repository/runtime evidence => implementation status UNKNOWN. Do not mark claims IMPLEMENTED from chat history alone. Chat history may support HISTORICALLY_ASSERTED. Frozen decisions require an explicit citation [CHAT:source_id:message_sequence] and status HISTORICALLY_FROZEN — never invent frozen invariants.
Critical claims should cite evidence.
Distinguish provenance: EVIDENCED, INFERRED, UNKNOWN, CONFLICTED, HISTORICALLY_ASSERTED, HISTORICALLY_FROZEN.

Output a single JSON object:
{"status":"APPROVED|BLOCKED|USER_DECISION_REQUIRED","consensus":[],"disagreements":[],"blockers":[],"recommendation":"",${positionsPrompt(roles)},"citations":[],"resolved_issues":[],"unresolved_issues":[],"artifact":{"type":"SPECIFICATION|ARCHITECTURE|PLAN|ADR|PROJECT_STATE|OTHER","title":"","version":"1.0","content":"markdown artifact","evidenceLabels":[{"claim":"","status":"EVIDENCED","citation":"[CHAT:source_id:1]"}]}}
P4 never blocks. Do not BLOCK only because a candidate or repository was missing. Use only the selected Council roles as keys in agent_positions.`;
}

export function decideSynthesisPrompt(roles: AgentKey[] = AGENTS): string {
  return `You are the DECIDE-mode synthesizer. Output a single JSON object:
{"status":"APPROVED|BLOCKED|USER_DECISION_REQUIRED","consensus":[],"disagreements":[],"blockers":[],"recommendation":"",${positionsPrompt(roles)},"decision":"","alternatives":[],"rationale":"","dissent":[],"evidence":[{"claim":"","status":"EVIDENCED","citation":"[CHAT:source_id:1]"}],"risks":[],"citations":[]}
Unresolved material disagreement or CONFLICTED evidence => USER_DECISION_REQUIRED. Substantiated P0/P1 => BLOCKED. Use only the selected Council roles as keys in agent_positions.`;
}

export const SYNTHESIS = reviewSynthesisPrompt();
export const CREATE_SYNTHESIS = createSynthesisPrompt();
export const DECIDE_SYNTHESIS = decideSynthesisPrompt();
export const REVIEW_SYNTHESIS = reviewSynthesisPrompt();

function baseResultProperties(roles: AgentKey[]) {
  return {
    status: { type: "string", enum: ["APPROVED", "PATCH", "BLOCKED", "USER_DECISION_REQUIRED"] },
    consensus: { type: "array", items: { type: "string" } },
    disagreements: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
    agent_positions: agentPositionSchema(roles),
    citations: { type: "array", items: { type: "string" } },
  };
}

export function makeReviewSchema(roles: AgentKey[] = AGENTS) {
  const properties = {
    ...baseResultProperties(roles),
    review_verdict: { type: "string", enum: ["PASS", "PATCH", "BLOCKED"] },
    issues: { type: "array", items: { type: "string" } },
    proposed_corrections: { type: "array", items: { type: "string" } },
    resolved_issues: { type: "array", items: { type: "string" } },
    unresolved_issues: { type: "array", items: { type: "string" } },
  };
  return {
    type: "json_schema",
    json_schema: {
      name: "council_result",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required: Object.keys(properties),
      },
    },
  };
}

export function makeCreateSchema(roles: AgentKey[] = AGENTS) {
  const properties = {
    ...baseResultProperties(roles),
    resolved_issues: { type: "array", items: { type: "string" } },
    unresolved_issues: { type: "array", items: { type: "string" } },
    artifact: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: {
          type: "string",
          enum: ["SPECIFICATION", "ARCHITECTURE", "PLAN", "ADR", "PROJECT_STATE", "OTHER"],
        },
        title: { type: "string" },
        version: { type: "string" },
        content: { type: "string" },
        evidenceLabels: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              claim: { type: "string" },
              status: {
                type: "string",
                enum: [
                  "EVIDENCED",
                  "INFERRED",
                  "UNKNOWN",
                  "CONFLICTED",
                  "HISTORICALLY_ASSERTED",
                  "HISTORICALLY_FROZEN",
                ],
              },
              citation: { type: "string" },
            },
            required: ["claim", "status", "citation"],
          },
        },
      },
      required: ["type", "title", "version", "content", "evidenceLabels"],
    },
  };
  return {
    type: "json_schema",
    json_schema: {
      name: "create_artifact_result",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required: Object.keys(properties),
      },
    },
  };
}

export function makeDecideSchema(roles: AgentKey[] = AGENTS) {
  const properties = {
    ...baseResultProperties(roles),
    decision: { type: "string" },
    rationale: { type: "string" },
    dissent: { type: "array", items: { type: "string" } },
    alternatives: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string" },
          status: {
            type: "string",
            enum: [
              "EVIDENCED",
              "INFERRED",
              "UNKNOWN",
              "CONFLICTED",
              "HISTORICALLY_ASSERTED",
              "HISTORICALLY_FROZEN",
            ],
          },
          citation: { type: "string" },
        },
        required: ["claim", "status", "citation"],
      },
    },
    risks: { type: "array", items: { type: "string" } },
  };
  return {
    type: "json_schema",
    json_schema: {
      name: "decide_result",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties,
        required: Object.keys(properties),
      },
    },
  };
}

export const SCHEMA = makeReviewSchema();
export const CREATE_SCHEMA = makeCreateSchema();
export const DECIDE_SCHEMA = makeDecideSchema();
export const REVIEW_SCHEMA = makeReviewSchema();

const PROMPT_RATE = 0.0000025;
const COMPLETION_RATE = 0.00001;
const EMPTY = new Set(["none", "n/a", "na", "-", "nil", "null", "no items"]);

export const AGENT_MAX = 6000;
export const SYNTH_MAX = 4000;
export const CREATE_SYNTH_MAX = 8000;
export const TYPICAL_AGENT_OUT = 1500;
export const TYPICAL_SYNTH_OUT = 800;
export const CONTEXT_TOKEN_LIMIT = CURRENT_CONTEXT_TOKEN_LIMIT;
export const CONTEXT_CHAR_LIMIT = CONTEXT_TOKEN_LIMIT * 4;

export function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

export function estimateCost(inputTokens: number, maxOut: number): number {
  return Math.max(1, inputTokens) * PROMPT_RATE + maxOut * COMPLETION_RATE;
}

export function modelFor(creds: ProviderCreds): Record<string, string> {
  return Object.fromEntries(creds.members.map((row) => [row.role, row.modelId.trim()]));
}

export function buildContext(
  project: { name: string; description: string },
  task: Task,
  items: ContextItem[],
  extras?: { manifestSummary?: string; candidateText?: string | null; files?: ProjectFile[] },
): string {
  const frozen = items.filter((item) => item.kind !== "RAW_HISTORY");
  const mandatory = buildMandatoryContext(project, task, frozen, {
    candidateText: extras?.candidateText,
  });
  if (extras?.manifestSummary) {
    return `${mandatory}\n${extras.manifestSummary}`;
  }
  return mandatory;
}

export function boundContext(ctx: string): string {
  if (countTokens(ctx) > CONTEXT_TOKEN_LIMIT) {
    throw new Error("CONTEXT_BUDGET_EXCEEDED");
  }
  return ctx;
}

export function estimateCouncilRun(
  ctx: string,
  maxCostUsd = 1,
  memberCount = AGENTS.length,
): {
  inputChars: number;
  inputTokens: number;
  uncappedChars: number;
  uncappedTokens: number;
  capped: boolean;
  costUsd: number;
  overBudget: boolean;
  expectedCalls: number;
} {
  const uncappedTokens = countTokens(ctx);
  const uncappedChars = ctx.length;
  const expected = expectedSuccessfulCalls(memberCount);
  if (uncappedTokens > CONTEXT_TOKEN_LIMIT) {
    return {
      inputChars: 0,
      inputTokens: 0,
      uncappedChars,
      uncappedTokens,
      capped: true,
      costUsd: 0,
      overBudget: true,
      expectedCalls: expected,
    };
  }
  const sentTokens = uncappedTokens;
  let costUsd = 0;
  const n = Math.max(2, memberCount);
  for (let i = 0; i < n; i += 1) {
    costUsd += estimateCost(80 + sentTokens, TYPICAL_AGENT_OUT);
  }
  for (let i = 0; i < n; i += 1) {
    costUsd += estimateCost(120 + sentTokens + 4 * TYPICAL_AGENT_OUT, TYPICAL_AGENT_OUT);
  }
  costUsd += estimateCost(160 + sentTokens + n * TYPICAL_AGENT_OUT, TYPICAL_SYNTH_OUT);
  const budget = maxCostUsd > 0 ? maxCostUsd : 1;
  return {
    inputChars: ctx.length,
    inputTokens: sentTokens,
    uncappedChars,
    uncappedTokens,
    capped: false,
    costUsd,
    overBudget: costUsd > budget,
    expectedCalls: expected,
  };
}

export function parseHeadings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const heading of HEADINGS) out[heading] = "";
  const headingRe =
    /^(?:#{1,3}\s*)?(?:\*\*)?(POSITION|P0_BLOCKERS|P1_ARCHITECTURE|P2_CORRECTNESS|P3_ROBUSTNESS|P4_IMPROVEMENTS|RECOMMENDATION|ACCEPTED_OBJECTIONS|REJECTED_OBJECTIONS|REMAINING_P0|REMAINING_P1|REVISED_POSITION)(?:\*\*)?\s*$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (!matches.length) {
    out.UNPARSED = text;
    return out;
  }
  matches.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    out[m[1]] = text.slice(start, end).trim();
  });
  return out;
}

export function hasItems(body: string): boolean {
  const lines = body
    .split("\n")
    .map((line) =>
      line
        .replace(/^[-*•]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .trim()
        .toLowerCase(),
    )
    .filter((line) => line && !EMPTY.has(line));
  return lines.length > 0;
}

export type ParsedSynth = {
  status: CouncilStatus;
  consensus: string[];
  disagreements: string[];
  blockers: string[];
  recommendation: string;
  agent_positions: Record<string, string>;
  decision: string | null;
  rationale: string | null;
  dissent: string[];
  artifact: ReturnType<typeof parseSynthesizedArtifact>;
  reviewVerdict: ReviewVerdict | null;
  alternatives: string[];
  evidence: EvidenceLabel[];
  risks: string[];
  issues: string[];
  proposedCorrections: string[];
  resolvedIssues: string[];
  unresolvedIssues: string[];
  citations: string[];
};

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => String(row)).map((row) => row.trim()).filter(Boolean);
}

function asCouncilStatus(value: unknown): CouncilStatus | null {
  const text = String(value ?? "").toUpperCase();
  if (text === "APPROVED" || text === "PASS") return "APPROVED";
  if (text === "PATCH") return "PATCH";
  if (text === "BLOCKED") return "BLOCKED";
  if (text === "USER_DECISION_REQUIRED") return "USER_DECISION_REQUIRED";
  return null;
}

export function normalizePositions(pos: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pos || typeof pos !== "object") return out;
  for (const [key, value] of Object.entries(pos)) {
    out[normalizeAgentKey(key)] = String(value ?? "");
  }
  return out;
}

export function parseJson(text: string): ParsedSynth | null {
  const candidates = [text.trim()];
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (fence?.[1]) candidates.unshift(fence[1]);
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const raw of candidates) {
    try {
      const data = JSON.parse(raw) as Record<string, unknown>;
      const status = asCouncilStatus(data.status);
      if (!status) continue;
      const pos = (data.agent_positions ?? data.agentPositions ?? {}) as Record<string, unknown>;
      return {
        status,
        consensus: asStringList(data.consensus),
        disagreements: asStringList(data.disagreements),
        blockers: asStringList(data.blockers),
        recommendation: String(data.recommendation ?? ""),
        agent_positions: normalizePositions(pos),
        decision: data.decision == null || data.decision === "" ? null : String(data.decision),
        rationale: data.rationale == null || data.rationale === "" ? null : String(data.rationale),
        dissent: asStringList(data.dissent),
        artifact: parseSynthesizedArtifact(data.artifact),
        reviewVerdict: asReviewVerdict(data.review_verdict ?? data.reviewVerdict ?? data.status),
        alternatives: asStringList(data.alternatives),
        evidence: parseEvidenceLabels(data.evidence),
        risks: asStringList(data.risks),
        issues: asStringList(data.issues),
        proposedCorrections: asStringList(data.proposed_corrections ?? data.proposedCorrections),
        resolvedIssues: asStringList(data.resolved_issues ?? data.resolvedIssues),
        unresolvedIssues: asStringList(data.unresolved_issues ?? data.unresolvedIssues),
        citations: asStringList(data.citations),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function applyGate(
  parsed: ParsedSynth,
  round2: AgentResponse[],
  mode: TaskMode | string = "REVIEW",
): { status: CouncilStatus; blockers: string[]; reason: string | null } {
  const p0: string[] = [];
  const p1: string[] = [];
  let p4Only = true;
  let parsedHeadings = false;
  for (const row of round2) {
    const structured = row.structured ?? {};
    if (!structured.UNPARSED && (structured.POSITION || structured.REVISED_POSITION || structured.P4_IMPROVEMENTS)) {
      parsedHeadings = true;
    }
    const remainingP0 = structured.REMAINING_P0 ?? "";
    const blockersP0 = structured.P0_BLOCKERS ?? "";
    const remainingP1 = structured.REMAINING_P1 ?? "";
    const archP1 = structured.P1_ARCHITECTURE ?? "";
    if (hasItems(remainingP0) || hasItems(blockersP0)) {
      p0.push(`${row.agent}: ${[remainingP0, blockersP0].filter((part) => hasItems(part)).join("\n").trim()}`);
      p4Only = false;
    }
    if (hasItems(remainingP1) || hasItems(archP1)) {
      p1.push(`${row.agent}: ${[remainingP1, archP1].filter((part) => hasItems(part)).join("\n").trim()}`);
      p4Only = false;
    }
    if (hasItems(structured.P2_CORRECTNESS ?? "") || hasItems(structured.P3_ROBUSTNESS ?? "")) p4Only = false;
  }

  const resolvedMode = normalizeTaskMode(mode);
  const gatedP0 = resolvedMode === "CREATE" ? filterCreateBlockers(p0) : p0;
  const gatedP1 = resolvedMode === "CREATE" ? filterCreateBlockers(p1) : p1;
  const parsedBlockers = resolvedMode === "CREATE" ? filterCreateBlockers(parsed.blockers) : parsed.blockers;

  const proposed = parsed.status;
  let status: CouncilStatus = proposed;
  let blockers = parsedBlockers;
  let reason: string | null = null;
  if (gatedP0.length) {
    status = "BLOCKED";
    blockers = [...gatedP0, ...blockers.filter((item) => !gatedP0.includes(item))];
    if (proposed !== "BLOCKED") reason = "Safety gate: unresolved P0 findings require BLOCKED.";
  } else if (gatedP1.length) {
    status = "BLOCKED";
    blockers = [...gatedP1, ...blockers.filter((item) => !gatedP1.includes(item))];
    if (proposed !== "BLOCKED") reason = "Safety gate: unresolved P1 findings require BLOCKED.";
  } else if (p4Only && parsedHeadings && status === "BLOCKED") {
    status = "APPROVED";
    blockers = [];
    reason = "P4-only criticism cannot cause BLOCKED.";
  } else if (resolvedMode === "CREATE" && status === "BLOCKED" && !gatedP0.length && !gatedP1.length) {
    status = proposed === "USER_DECISION_REQUIRED" ? "USER_DECISION_REQUIRED" : "APPROVED";
    blockers = [];
    reason =
      "CREATE safety gate: missing candidate or repository evidence cannot block artifact creation.";
  } else if (resolvedMode === "REVIEW" && proposed === "PATCH" && !gatedP0.length && !gatedP1.length) {
    status = "PATCH";
  } else if (
    resolvedMode === "DECIDE" &&
    proposed === "APPROVED" &&
    (parsed.disagreements.length > 0 || parsed.evidence.some((row) => row.status === "CONFLICTED"))
  ) {
    status = "USER_DECISION_REQUIRED";
    reason = "Safety gate: DECIDE disagreements or CONFLICTED evidence require USER_DECISION_REQUIRED.";
  }
  return { status, blockers, reason };
}

export function attachManifest(
  row: AgentResponse,
  manifest: ContextManifest | null,
): AgentResponse {
  if (!manifest) return row;
  return { ...row, contextManifestId: manifest.id, contextHash: manifest.hash };
}

export function responseFromCompletion(
  taskId: string,
  agent: AgentKey,
  round: 1 | 2 | 3,
  system: string,
  user: string,
  out: Completion,
  manifest: ContextManifest | null = null,
  provider: ProviderId = "nanogpt",
): AgentResponse {
  return attachManifest(
    {
      id: nid(),
      taskId,
      agent,
      round,
      model: out.model,
      provider,
      promptSnapshot: `[SYSTEM]\n${system}\n[USER]\n${user}`,
      responseText: out.text,
      structured: round === 3 ? null : parseHeadings(out.text),
      inputTokens: out.inputTokens,
      cachedInputTokens: out.cachedInputTokens,
      outputTokens: out.outputTokens,
      reasoningTokens: out.reasoningTokens,
      cost: out.cost,
      requestId: out.requestId,
      latencyMs: out.latencyMs,
      error: null,
      contextManifestId: null,
      contextHash: null,
      runId: null,
    },
    manifest,
  );
}

export function responseFromError(
  taskId: string,
  agent: AgentKey,
  round: 1 | 2 | 3,
  model: string,
  system: string,
  user: string,
  error: string,
  manifest: ContextManifest | null = null,
  provider: ProviderId = "nanogpt",
): AgentResponse {
  return attachManifest(
    {
      id: nid(),
      taskId,
      agent,
      round,
      model,
      provider,
      promptSnapshot: `[SYSTEM]\n${system}\n[USER]\n${user}`,
      responseText: "",
      structured: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cost: null,
      requestId: null,
      latencyMs: null,
      error,
      contextManifestId: null,
      contextHash: null,
      runId: null,
    },
    manifest,
  );
}

export function failedOutput(
  task: Task,
  responses: AgentResponse[],
  error: string,
  extras?: { manifest?: ContextManifest | null; artifact?: Artifact | null; packet?: import("./types.ts").ImplementationPacket | null },
): RunCouncilOutput {
  const costs = responses.map((row) => row.cost).filter((value): value is number => value != null);
  return {
    task: {
      ...task,
      status: "FAILED",
      error,
      completedAt: new Date().toISOString(),
      totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : task.totalCostUsd,
      contextManifestId: extras?.manifest?.id ?? task.contextManifestId,
      contextHash: extras?.manifest?.hash ?? task.contextHash,
    },
    responses,
    result: null,
    artifact: extras?.artifact ?? null,
    manifest: extras?.manifest ?? null,
    packet: extras?.packet ?? null,
  };
}

export function cancelledOutput(
  task: Task,
  responses: AgentResponse[],
  extras?: { manifest?: ContextManifest | null; message?: string },
): RunCouncilOutput {
  const message = extras?.message ?? "Council run stopped.";
  return {
    task: {
      ...task,
      status: "CANCELLED",
      error: message,
      completedAt: new Date().toISOString(),
      contextManifestId: extras?.manifest?.id ?? task.contextManifestId,
      contextHash: extras?.manifest?.hash ?? task.contextHash,
    },
    responses,
    result: null,
    artifact: null,
    manifest: extras?.manifest ?? null,
    packet: null,
  };
}

export function precheckOutput(task: Task, error: string): RunCouncilOutput {
  return {
    task: {
      ...task,
      status: "CREATED",
      error,
      diagnostics: { ...(task.diagnostics ?? {}), precheck: "FAIL" },
    },
    responses: [],
    result: null,
    artifact: null,
    manifest: null,
    packet: null,
  };
}

export function completeOutput(
  task: Task,
  responses: AgentResponse[],
  parsed: ParsedSynth,
  gated: { status: CouncilStatus; blockers: string[]; reason: string | null },
  extras?: {
    artifact?: Artifact | null;
    manifest?: ContextManifest | null;
    packet?: import("./types.ts").ImplementationPacket | null;
    packedCitations?: string[];
    failedAgents?: AgentKey[];
  },
): RunCouncilOutput {
  const ins = responses.map((r) => r.inputTokens).filter((n): n is number => n !== null);
  const outs = responses.map((r) => r.outputTokens).filter((n): n is number => n !== null);
  const costs = responses.map((r) => r.cost).filter((n): n is number => n !== null);
  const lats = responses.map((r) => r.latencyMs).filter((n): n is number => n !== null);
  const synth = responses.find((r) => r.round === 3);
  const reviewVerdict =
    task.mode === "REVIEW"
      ? parsed.reviewVerdict ?? reviewVerdictFromStatus(gated.status)
      : null;
  const citations = [...new Set([...(extras?.packedCitations ?? []), ...parsed.citations])];
  const result: CouncilResult = {
    taskId: task.id,
    status: gated.status,
    consensus: parsed.consensus,
    disagreements: parsed.disagreements,
    blockers: gated.blockers,
    recommendation: parsed.recommendation,
    agentPositions: parsed.agent_positions,
    synthesisRaw: synth?.responseText ?? null,
    synthesizerProposedStatus: parsed.status,
    finalEnforcedStatus: gated.status,
    verdictOverride: gated.reason !== null,
    overrideReason: gated.reason,
    decision: parsed.decision,
    rationale: parsed.rationale,
    dissent: parsed.dissent,
    reviewVerdict,
    alternatives: parsed.alternatives,
    evidence: parsed.evidence,
    risks: parsed.risks,
    issues: parsed.issues,
    proposedCorrections: parsed.proposedCorrections,
    resolvedIssues: parsed.resolvedIssues,
    unresolvedIssues: parsed.unresolvedIssues,
    citations,
    failedAgents: extras?.failedAgents ?? [],
  };
  return {
    task: {
      ...task,
      status: "COMPLETE",
      error: null,
      completedAt: new Date().toISOString(),
      totalInputTokens: ins.length ? ins.reduce((a, b) => a + b, 0) : null,
      totalOutputTokens: outs.length ? outs.reduce((a, b) => a + b, 0) : null,
      totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
      totalLatencyMs: lats.length ? lats.reduce((a, b) => a + b, 0) : null,
      diagnostics: {
        ...(task.diagnostics ?? {}),
        structured_output: "json_schema",
        round1_independent: true,
      },
      contextManifestId: extras?.manifest?.id ?? task.contextManifestId,
      contextHash: extras?.manifest?.hash ?? task.contextHash,
    },
    responses,
    result,
    artifact: extras?.artifact ?? null,
    manifest: extras?.manifest ?? null,
    packet: extras?.packet ?? null,
  };
}

export function chat(system: string, user: string): ChatMessage[] {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function synthesisForMode(
  mode: TaskMode | string | null | undefined,
  roles: AgentKey[] = AGENTS,
) {
  const resolved = normalizeTaskMode(mode);
  if (resolved === "CREATE") {
    return { prompt: createSynthesisPrompt(roles), schema: makeCreateSchema(roles), max: CREATE_SYNTH_MAX };
  }
  if (resolved === "DECIDE") {
    return { prompt: decideSynthesisPrompt(roles), schema: makeDecideSchema(roles), max: SYNTH_MAX };
  }
  return { prompt: reviewSynthesisPrompt(roles), schema: makeReviewSchema(roles), max: SYNTH_MAX };
}

export type { CouncilMember, CouncilRole };
