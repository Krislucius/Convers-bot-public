import type { FileKind } from "./files";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export type AgentKey = "GPT" | "GROK" | "CLAUDE";

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
  | "COUNCIL_ROUND_1"
  | "COUNCIL_ROUND_2"
  | "SYNTHESIS"
  | "COMPLETE"
  | "FAILED";

export type CouncilStatus = "APPROVED" | "BLOCKED" | "USER_DECISION_REQUIRED";

export type ProviderId = "openrouter" | "openrusrouter";

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
  gptModel: string;
  grokModel: string;
  claudeModel: string;
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
};

export type CouncilResult = {
  taskId: string;
  status: CouncilStatus;
  consensus: string[];
  disagreements: string[];
  blockers: string[];
  recommendation: string;
  agentPositions: { gpt: string; grok: string; claude: string };
  synthesisRaw: string | null;
  synthesizerProposedStatus: CouncilStatus | null;
  finalEnforcedStatus: CouncilStatus | null;
  verdictOverride: boolean;
  overrideReason: string | null;
  decision: string | null;
  rationale: string | null;
  dissent: string[];
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
  } | null;
  selectedChatSourceIds: string[];
  selectedFileIds: string[];
  mode: TaskMode;
  requiresHistoricalContext: boolean;
  candidateArtifactId: string | null;
  decisionQuestion: string | null;
  contextManifestId: string | null;
  contextHash: string | null;
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
};

export type RunCouncilOutput = {
  task: Task;
  responses: AgentResponse[];
  result: CouncilResult | null;
  artifact: Artifact | null;
  manifest: ContextManifest | null;
};

export type ConnectionCheck = { ok: boolean; label: string; detail: string };

export type AccountSettingsPublic = {
  provider: ProviderId;
  gptModel: string;
  grokModel: string;
  claudeModel: string;
  maxCostUsd: number;
  openrouter: { saved: boolean; masked: string };
  openrusrouter: { saved: boolean; masked: string };
};

export type PreflightClientReport = {
  ok: boolean;
  error?: string;
  checks: Record<string, ConnectionCheck>;
  models: Record<string, string>;
  log: string;
};

export type { ChatSource, HistoryMessage };
