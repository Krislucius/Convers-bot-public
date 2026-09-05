import type { FileKind } from "./files";
import type { EvidenceManifest } from "@/lib/evidence/types";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";
import type { CouncilRole } from "./roles";
import type { CouncilMember } from "./members";
import type { DiscoverySnapshot } from "./discover";

export type AgentKey = CouncilRole;

export type TaskMode = "CREATE" | "REVIEW" | "DECIDE";

export type ContextKind =
  | "INVARIANT"
  | "DECISION"
  | "SPECIFICATION"
  | "PROJECT_STATE"
  | "RAW_HISTORY";

export type ContextStatus = "FROZEN" | "ACTIVE" | "RAW";

export type TaskStatus =
  | "CREATED"
  | "PREPARING"
  | "COUNCIL_ROUND_1"
  | "COUNCIL_ROUND_2"
  | "SYNTHESIS"
  | "COMPLETE"
  | "FAILED"
  | "CANCELLED";

export type AgentRunState = "WAITING" | "RUNNING" | "DONE" | "FAILED";

export type AgentProgress = {
  state: AgentRunState;
  attempt: number;
  maxAttempts: number;
  error: string | null;
};

export type CouncilStatus = "APPROVED" | "PATCH" | "BLOCKED" | "USER_DECISION_REQUIRED";

export type ReviewVerdict = "PASS" | "PATCH" | "BLOCKED";

export type ProviderId = "nanogpt" | "openrouter" | "openrusrouter";

export type ArtifactType =
  | "SPECIFICATION"
  | "ARCHITECTURE"
  | "PLAN"
  | "ADR"
  | "PROJECT_STATE"
  | "OTHER";

export type ArtifactStatus = "DRAFT" | "BLOCKED" | "READY_FOR_REVIEW" | "APPROVED" | "SUPERSEDED";

export type EvidenceStatus =
  | "EVIDENCED"
  | "INFERRED"
  | "UNKNOWN"
  | "CONFLICTED"
  | "HISTORICALLY_ASSERTED"
  | "HISTORICALLY_FROZEN";

export type EvidenceLabel = {
  claim: string;
  status: EvidenceStatus;
  citation: string | null;
};

export type Artifact = {
  id: string;
  projectId: string;
  taskId: string;
  type: ArtifactType;
  title: string;
  version: string;
  content: string;
  status: ArtifactStatus;
  contextHash: string;
  evidenceLabels: EvidenceLabel[];
  createdAt: string;
};

export type ChatManifestRow = {
  source_id: string;
  title: string;
  provider: string;
  import_status: string;
  access_status: string;
  message_count: number | null;
  character_count: number;
  estimated_tokens: number | null;
  content_available_locally: boolean;
};

export type FileManifestRow = {
  file_id: string;
  filename: string;
  kind: FileKind;
  character_count: number;
  estimated_tokens: number;
  member_count: number;
  include_in_memory: boolean;
};

export type ContextManifestPayload = {
  project: { id: string; name: string; description: string };
  task: {
    id: string;
    title: string;
    prompt: string;
    mode: TaskMode;
    requiresHistoricalContext: boolean;
    candidateArtifactId: string | null;
    decisionQuestion: string | null;
  };
  selectedAiChats: ChatManifestRow[];
  selectedFiles: FileManifestRow[];
  activeDecisions: Array<{ id: string; content: string }>;
  frozenInvariants: Array<{ id: string; content: string }>;
  activeSpecifications: Array<{ id: string; content: string }>;
  projectState: Array<{ id: string; content: string }>;
  candidateArtifact: { id: string; title: string; version: string; status: string } | null;
  evidence: EvidenceManifest | null;
};

export type ContextManifest = {
  id: string;
  taskId: string;
  hash: string;
  payload: ContextManifestPayload;
  createdAt: string;
};

export type ProviderCreds = {
  provider: ProviderId;
  apiKey: string;
  members: CouncilMember[];
  synthesizerModel: string;
  maxCostUsd: number;
};

export type ChatMessage = { role: "system" | "user"; content: string };

export type Completion = {
  text: string;
  model: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  requestId: string | null;
  latencyMs: number;
};

export type ProjectFile = {
  id: string;
  projectId: string;
  filename: string;
  kind: FileKind;
  extractedText: string;
  members: string[];
  notes: string;
  sizeBytes: number;
  characterCount: number;
  estimatedTokens: number;
  includeInMemory: boolean;
  createdAt: string;
};

export type Project = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

export type ContextItem = {
  id: string;
  projectId: string;
  source: "USER" | "IMPORT";
  kind: ContextKind;
  content: string;
  status: ContextStatus;
  createdAt: string;
};

export type AgentResponse = {
  id: string;
  taskId: string;
  agent: AgentKey;
  round: 1 | 2 | 3;
  model: string;
  provider: string | null;
  promptSnapshot: string;
  responseText: string;
  structured: Record<string, string> | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  requestId: string | null;
  latencyMs: number | null;
  error: string | null;
  contextManifestId: string | null;
  contextHash: string | null;
  runId: string | null;
};

export type CouncilResult = {
  taskId: string;
  status: CouncilStatus;
  consensus: string[];
  disagreements: string[];
  blockers: string[];
  recommendation: string;
  agentPositions: Record<string, string>;
  synthesisRaw: string | null;
  synthesizerProposedStatus: CouncilStatus | null;
  finalEnforcedStatus: CouncilStatus | null;
  verdictOverride: boolean;
  overrideReason: string | null;
  decision: string | null;
  rationale: string | null;
  dissent: string[];
  reviewVerdict: ReviewVerdict | null;
  alternatives: string[];
  evidence: EvidenceLabel[];
  risks: string[];
  issues: string[];
  proposedCorrections: string[];
  resolvedIssues: string[];
  unresolvedIssues: string[];
  citations: string[];
  failedAgents: AgentKey[];
};

export type PacketStatus = "READY" | "HANDED_OFF" | "RESULT_RECORDED" | "REVIEW_OPEN" | "CLOSED";

export type ImplementationStatus = "SUCCEEDED" | "FAILED" | "PARTIAL";

export type ImplementationPacket = {
  id: string;
  projectId: string;
  taskId: string;
  artifactId: string;
  parentPacketId: string | null;
  iteration: number;
  status: PacketStatus;
  scope: string;
  requirements: string[];
  invariants: string[];
  evidenceRefs: string[];
  acceptanceTests: string[];
  blockers: string[];
  packetHash: string;
  handoffAt: string | null;
  implementationStatus: ImplementationStatus | null;
  implementationNotes: string | null;
  implementationRecordedAt: string | null;
  reviewTaskId: string | null;
  createdAt: string;
};

export type TaskQualityRow = {
  taskId: string;
  mode: TaskMode;
  councilOutcome: string;
  reviewVerdict: ReviewVerdict | null;
  disagreements: number;
  evidenceUsed: number;
  iteration: number;
  packetStatus: PacketStatus | null;
  laterCorrection: boolean;
};

export type ProjectQualitySummary = {
  projectId: string;
  taskCount: number;
  approvedOrPass: number;
  patch: number;
  blocked: number;
  disagreements: number;
  evidenceUsed: number;
  iterations: number;
  laterCorrections: number;
  rows: TaskQualityRow[];
};

export type RunDiagnostics = {
  runId: string;
  generation: number;
  stage: "PREPARING" | "ROUND_1" | "ROUND_2" | "SYNTHESIS" | "COMPLETE" | "CANCELLED";
  status: TaskStatus;
  startedAt: string;
  stageStartedAt: string;
  updatedAt: string;
  agents: Partial<Record<AgentKey, AgentProgress>>;
  message: string;
  provider?: ProviderId;
  members?: CouncilMember[];
  synthesizerModel?: string;
  requestBudget?: { used: number; limit: number; expected: number };
  costUsd?: number | null;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  totalLatencyMs: number | null;
  diagnostics: {
    structured_output?: string;
    round1_independent?: boolean;
    precheck?: string;
    run?: RunDiagnostics | null;
    runs?: RunDiagnostics[];
  } | null;
  selectedChatSourceIds: string[];
  selectedFileIds: string[];
  mode: TaskMode;
  requiresHistoricalContext: boolean;
  candidateArtifactId: string | null;
  decisionQuestion: string | null;
  contextManifestId: string | null;
  contextHash: string | null;
  provider: ProviderId | null;
  selectedModels?: CouncilMember[] | null;
};

export type StoreShape = {
  projects: Project[];
  context: ContextItem[];
  tasks: Task[];
  responses: AgentResponse[];
  results: CouncilResult[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  projectFiles: ProjectFile[];
  artifacts: Artifact[];
  manifests: ContextManifest[];
  packets: ImplementationPacket[];
};

export type RunCouncilOutput = {
  task: Task;
  responses: AgentResponse[];
  result: CouncilResult | null;
  artifact: Artifact | null;
  manifest: ContextManifest | null;
  packet: ImplementationPacket | null;
};

export type ConnectionCheck = { ok: boolean; label: string; detail: string };

export type AccountSettingsPublic = {
  provider: ProviderId;
  selectedModelIds: string[];
  synthesizerModel: string;
  catalog: DiscoverySnapshot | null;
  gptModel: string;
  grokModel: string;
  claudeModel: string;
  maxCostUsd: number;
  lastTestLog: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  nanogpt: { saved: boolean; masked: string };
  openrouter: { saved: boolean; masked: string };
  openrusrouter: { saved: boolean; masked: string };
};

export type PreflightClientReport = {
  ok: boolean;
  error?: string;
  checks: Record<string, ConnectionCheck>;
  models: Record<string, string>;
  log: string;
  catalog?: DiscoverySnapshot;
};

export type { ChatSource, HistoryMessage };
export type { CouncilMember, DiscoverySnapshot };
