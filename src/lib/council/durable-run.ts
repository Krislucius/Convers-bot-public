import type { CouncilMember } from "./members.ts";
import type { DiscoverySnapshot } from "./discover.ts";
import type { NanoGptBillingMode } from "./nano-billing.ts";
import type { CouncilRunSnapshot, CouncilStageName } from "./run-control.ts";
import type {
  AgentKey,
  AgentProgress,
  AgentResponse,
  Artifact,
  ContextItem,
  ContextManifest,
  ImplementationPacket,
  ProjectFile,
  ProviderId,
  RunCouncilOutput,
  Task,
  TaskStatus,
} from "./types.ts";
import type { ChatSource, HistoryMessage } from "../history/types.ts";
import type { DiscoveredModel } from "./discover.ts";
import { emptyRequestBudget, type RequestBudget } from "./request-budget.ts";
import { PROVIDER_ATTEMPTS } from "./provider-error.ts";
import type { PreflightReport } from "./start-preflight.ts";
import type { ModelHealth } from "./model-health.ts";
import { diagnoseInternalStage, type StallStage } from "./pacing.ts";
import { decideDurableWrite, exclusiveRunState, hasPersistedSynthesis } from "./terminal.ts";

export const DURABLE_LEASE_MS = 90_000;
export const DURABLE_TICK_BUDGET_MS = 25_000;
export const SWEEP_INTERVAL_MS = 60_000;
export const SWEEP_PATH = "/api/council/sweep";
export const SWEEP_SCHEDULE = "* * * * *";
export const MAX_DORMANT_MS = SWEEP_INTERVAL_MS + DURABLE_LEASE_MS;

export const DURABLE_STATUSES = [
  "QUEUED",
  "PREPARING",
  "ROUND_1",
  "ROUND_2",
  "SYNTHESIS",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
] as const;

export type DurableStatus = (typeof DURABLE_STATUSES)[number];
export type DurableStage = CouncilStageName | "QUEUED";

export type DurableCursor = {
  phase: DurableStatus;
  packedText: string | null;
  manifest: ContextManifest | null;
  contextHash: string | null;
  requestUsed: number;
  preflightCalls: number;
  councilCalls: number;
  retries: number;
  completedKeys: string[];
  synthIndex: number;
  tokenIn: number;
  tokenOut: number;
  latencyMs: number;
  spent: number | null;
  catalogOk: boolean;
  accessOk: boolean;
  preflight: PreflightReport | null;
  callableMemberIds: string[];
  currentMemberId: string | null;
  currentModelId: string | null;
  currentRequestStartedAt: string | null;
  lastProviderResponseAt: string | null;
  lastProviderHttpStatus: number | null;
  internalStage: StallStage | string;
  stallReason: string | null;
  modelHealth: Record<string, ModelHealth>;
};

export type DurableFrozenInput = {
  project: { id: string; name: string; description: string };
  task: Task;
  context: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  projectFiles: ProjectFile[];
  artifacts: Artifact[];
  parentPacket: ImplementationPacket | null;
  catalog?: DiscoveredModel[];
  scan?: DiscoverySnapshot | null;
  resumeResponses?: AgentResponse[];
  members: CouncilMember[];
  synthesizerModel: string;
  maxCostUsd: number;
  provider: ProviderId;
  nanogptBilling?: NanoGptBillingMode;
};

export type DurableRunRow = {
  runId: string;
  userId: string;
  taskId: string;
  generation: number;
  leaseEpoch: number;
  status: DurableStatus;
  stage: DurableStage;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  tickToken: string;
  cursor: DurableCursor;
  snapshot: CouncilRunSnapshot;
  frozenInput: DurableFrozenInput;
  contextHash: string | null;
  provider: ProviderId;
  nanogptBilling: NanoGptBillingMode | null;
  members: CouncilMember[];
  synthesizerModel: string;
  catalog: DiscoveredModel[] | null;
  startedAt: string;
  lastProgressAt: string;
  lastWakeAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
  responses: AgentResponse[];
  output: RunCouncilOutput | null;
};

export type DurableRunPublic = {
  runId: string;
  taskId: string;
  generation: number;
  status: DurableStatus;
  stage: DurableStage;
  taskStatus: TaskStatus;
  startedAt: string;
  lastProgressAt: string;
  lastWakeAt: string | null;
  leaseExpiresAt: string | null;
  nextRecoveryDeadline: string;
  message: string;
  provider: ProviderId;
  members: CouncilMember[];
  agents: Partial<Record<AgentKey, AgentProgress>>;
  requestBudget?: RequestBudget;
  costUsd?: number | null;
  nanogptBilling?: NanoGptBillingMode | null;
  snapshot: CouncilRunSnapshot;
  responses: AgentResponse[];
  output: RunCouncilOutput | null;
  background: true;
  cancelRequested: boolean;
  currentMemberId?: string | null;
  currentRequestStartedAt?: string | null;
  lastProviderResponseAt?: string | null;
  internalStage?: string | null;
  stallReason?: string | null;
};

export const TERMINAL_STATUSES = new Set<DurableStatus>(["COMPLETE", "FAILED", "CANCELLED"]);

export function isTerminalStatus(status: DurableStatus | string): boolean {
  return TERMINAL_STATUSES.has(status as DurableStatus);
}

export function completedKey(stage: string, memberId: string): string {
  return `${stage}:${memberId}`;
}

export function emptyCursor(): DurableCursor {
  return {
    phase: "QUEUED",
    packedText: null,
    manifest: null,
    contextHash: null,
    requestUsed: 0,
    preflightCalls: 0,
    councilCalls: 0,
    retries: 0,
    completedKeys: [],
    synthIndex: 0,
    tokenIn: 0,
    tokenOut: 0,
    latencyMs: 0,
    spent: null,
    catalogOk: false,
    accessOk: false,
    preflight: null,
    callableMemberIds: [],
    currentMemberId: null,
    currentModelId: null,
    currentRequestStartedAt: null,
    lastProviderResponseAt: null,
    lastProviderHttpStatus: null,
    internalStage: "SCHEDULER_WAIT",
    stallReason: null,
    modelHealth: {},
  };
}

export function hydrateCursor(cursor?: Partial<DurableCursor> | null): DurableCursor {
  return { ...emptyCursor(), ...(cursor ?? {}) };
}

export function waitingAgents(members: CouncilMember[]): Partial<Record<AgentKey, AgentProgress>> {
  return Object.fromEntries(
    members.map((row) => [
      row.memberId,
      { state: "WAITING" as const, attempt: 0, maxAttempts: PROVIDER_ATTEMPTS, error: null },
    ]),
  );
}

export function taskStatusFor(status: DurableStatus, stage: DurableStage): TaskStatus {
  if (status === "COMPLETE") return "COMPLETE";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "CANCELLED";
  if (status === "SYNTHESIS" || stage === "SYNTHESIS") return "SYNTHESIS";
  if (status === "ROUND_2" || stage === "ROUND_2") return "COUNCIL_ROUND_2";
  if (status === "ROUND_1" || stage === "ROUND_1") return "COUNCIL_ROUND_1";
  return "PREPARING";
}

export function newRunId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

export function newTickToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function cloneRow(row: DurableRunRow): DurableRunRow {
  return JSON.parse(JSON.stringify(row)) as DurableRunRow;
}

export function shouldAcceptDurableWrite(
  current: { runId: string; generation: number; leaseEpoch: number },
  incoming: { runId?: string | null; generation?: number | null; leaseEpoch?: number | null },
): boolean {
  if (!incoming.runId || incoming.runId !== current.runId) return false;
  if (incoming.generation == null || incoming.generation !== current.generation) return false;
  if (incoming.leaseEpoch == null || incoming.leaseEpoch !== current.leaseEpoch) return false;
  return true;
}

export function leaseHeld(row: DurableRunRow, nowMs: number, owner?: string): boolean {
  if (!row.leaseOwner || row.leaseExpiresAt == null) return false;
  if (row.leaseExpiresAt <= nowMs) return false;
  if (owner && row.leaseOwner === owner) return false;
  return true;
}

export function canClaimLease(row: DurableRunRow, nowMs: number, owner: string): boolean {
  if (isTerminalStatus(row.status) && !row.cancelRequested) return false;
  if (isTerminalStatus(row.status) && row.status !== "CANCELLED") return false;
  if (isTerminalStatus(row.status)) return false;
  if (!leaseHeld(row, nowMs, owner)) return true;
  return false;
}

export function isReclaimable(row: DurableRunRow, nowMs: number): boolean {
  if (isTerminalStatus(row.status)) return false;
  return canClaimLease(row, nowMs, `sweep-${nowMs}`);
}

export function leaseExpiresAtIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function nextRecoveryDeadlineMs(
  row: Pick<DurableRunRow, "leaseExpiresAt">,
  nowMs: number,
  intervalMs = SWEEP_INTERVAL_MS,
): number {
  const leaseEnd = row.leaseExpiresAt != null && row.leaseExpiresAt > nowMs ? row.leaseExpiresAt : nowMs;
  return leaseEnd + intervalMs;
}

export function toPublic(row: DurableRunRow, nowMs = Date.now()): DurableRunPublic {
  const responses = row.responses.length ? row.responses : (row.output?.responses ?? []);
  const deadline = nextRecoveryDeadlineMs(row, nowMs);
  const leaseIsHeld = leaseHeld(row, nowMs);
  const preflightDone = Boolean(row.cursor.accessOk && row.cursor.catalogOk);
  const providerCallsStarted = (row.cursor.councilCalls ?? 0) > 0 || Boolean(row.cursor.lastProviderResponseAt);
  const internalStage = leaseIsHeld
    ? "LEASE_WAIT"
    : row.cursor.internalStage ||
      diagnoseInternalStage({
        failed: row.status === "FAILED",
        terminal: isTerminalStatus(row.status),
        leaseHeld: leaseIsHeld,
        preflightDone,
        providerCallsStarted,
        queued: row.status === "QUEUED" || row.cursor.phase === "QUEUED",
      });
  const terminal = exclusiveRunState({
    status: row.status,
    snapshotStatus: row.snapshot.status,
    hasSynthesis: hasPersistedSynthesis({
      status: row.status,
      output: row.output,
      responses: row.responses,
      mode: row.frozenInput.task.mode,
      artifact: row.output?.artifact ?? null,
    }),
    result: row.output?.result ?? null,
    hasArtifact: Boolean(row.output?.artifact),
  });
  const publicStatus = terminal ?? row.status;
  const taskStatus = terminal ?? taskStatusFor(row.status, row.stage);
  const snapshot: CouncilRunSnapshot = {
    ...row.snapshot,
    status: taskStatus,
    stage: terminal === "COMPLETE" ? "COMPLETE" : terminal === "CANCELLED" ? "CANCELLED" : row.snapshot.stage,
    lastWakeAt: row.lastWakeAt,
    leaseExpiresAt: leaseExpiresAtIso(row.leaseExpiresAt),
    nextRecoveryDeadline: new Date(deadline).toISOString(),
    currentMemberId: row.cursor.currentMemberId,
    currentModelId: row.cursor.currentModelId,
    currentRequestStartedAt: row.cursor.currentRequestStartedAt,
    lastProviderResponseAt: row.cursor.lastProviderResponseAt,
    lastProviderHttpStatus: row.cursor.lastProviderHttpStatus,
    lastProgressAt: row.lastProgressAt,
    internalStage,
    stallReason: row.cursor.stallReason,
    preflight: row.cursor.preflight ?? row.snapshot.preflight ?? null,
    requestBudget: {
      used: row.cursor.requestUsed,
      limit: row.snapshot.requestBudget?.limit ?? emptyRequestBudget(row.members.length || 3).limit,
      expected: row.snapshot.requestBudget?.expected ?? emptyRequestBudget(row.members.length || 3).expected,
      preflightCalls: row.cursor.preflightCalls ?? row.snapshot.requestBudget?.preflightCalls ?? 0,
      councilCalls: row.cursor.councilCalls ?? row.snapshot.requestBudget?.councilCalls ?? 0,
      retries: row.cursor.retries ?? row.snapshot.requestBudget?.retries ?? 0,
    },
  };
  return {
    runId: row.runId,
    taskId: row.taskId,
    generation: row.generation,
    status: publicStatus,
    stage: terminal === "COMPLETE" ? "COMPLETE" : terminal === "CANCELLED" ? "CANCELLED" : row.stage,
    taskStatus,
    startedAt: row.startedAt,
    lastProgressAt: row.lastProgressAt,
    lastWakeAt: row.lastWakeAt,
    leaseExpiresAt: leaseExpiresAtIso(row.leaseExpiresAt),
    nextRecoveryDeadline: new Date(deadline).toISOString(),
    message: row.snapshot.message || row.error || "",
    provider: row.provider,
    members: row.members,
    agents: row.snapshot.agents ?? {},
    requestBudget: snapshot.requestBudget,
    costUsd: row.snapshot.costUsd ?? null,
    nanogptBilling: row.nanogptBilling,
    snapshot,
    responses,
    output: row.output,
    background: true,
    cancelRequested: row.cancelRequested,
    currentMemberId: row.cursor.currentMemberId,
    currentRequestStartedAt: row.cursor.currentRequestStartedAt,
    lastProviderResponseAt: row.cursor.lastProviderResponseAt,
    internalStage,
    stallReason: row.cursor.stallReason,
  };
}

export function initialSnapshot(row: {
  runId: string;
  generation: number;
  members: CouncilMember[];
  provider: ProviderId;
  synthesizerModel: string;
  nanogptBilling?: NanoGptBillingMode | null;
  startedAt: string;
  message?: string;
}): CouncilRunSnapshot {
  return {
    runId: row.runId,
    generation: row.generation,
    stage: "PREPARING",
    status: "PREPARING",
    startedAt: row.startedAt,
    stageStartedAt: row.startedAt,
    updatedAt: row.startedAt,
    agents: waitingAgents(row.members),
    message: row.message ?? "Queued on the server. Running in background.",
    provider: row.provider,
    members: row.members,
    synthesizerModel: row.synthesizerModel,
    requestBudget: emptyRequestBudget(row.members.length || 3),
    costUsd: 0,
    nanogptBilling: row.nanogptBilling ?? undefined,
    currentMemberId: null,
    currentModelId: null,
    currentStage: "PREPARING",
    currentAttempt: 0,
    currentRequestStartedAt: null,
    lastProviderResponseAt: null,
    lastProgressAt: row.startedAt,
    internalStage: "SCHEDULER_WAIT",
    stallReason: null,
    preflight: null,
  };
}

export type DurableStore = {
  insert(row: DurableRunRow): Promise<DurableRunRow>;
  get(runId: string): Promise<DurableRunRow | null>;
  getActive(userId: string, taskId: string): Promise<DurableRunRow | null>;
  listActive(userId: string): Promise<DurableRunRow[]>;
  listReclaimable(nowMs: number): Promise<DurableRunRow[]>;
  touchWakes(iso: string): Promise<number>;
  claimLease(runId: string, owner: string, nowMs: number, leaseMs?: number): Promise<DurableRunRow | null>;
  write(
    row: DurableRunRow,
    expected: { generation: number; leaseEpoch: number },
  ): Promise<boolean>;
};

export class OneActiveRunError extends Error {
  readonly existingRunId: string;
  constructor(existingRunId: string) {
    super("ONE_ACTIVE_COUNCIL_RUN");
    this.name = "OneActiveRunError";
    this.existingRunId = existingRunId;
  }
}

export function createMemoryDurableStore(seed: DurableRunRow[] = []): DurableStore {
  const byId = new Map<string, DurableRunRow>(seed.map((row) => [row.runId, cloneRow(row)]));

  return {
    async insert(row) {
      const active = [...byId.values()].find(
        (item) => item.userId === row.userId && item.taskId === row.taskId && !isTerminalStatus(item.status),
      );
      if (active) throw new OneActiveRunError(active.runId);
      const copy = cloneRow(row);
      if (copy.lastWakeAt === undefined) copy.lastWakeAt = null;
      byId.set(copy.runId, copy);
      return cloneRow(copy);
    },
    async get(runId) {
      const row = byId.get(runId);
      return row ? cloneRow(row) : null;
    },
    async getActive(userId, taskId) {
      const row = [...byId.values()].find(
        (item) => item.userId === userId && item.taskId === taskId && !isTerminalStatus(item.status),
      );
      return row ? cloneRow(row) : null;
    },
    async listActive(userId) {
      return [...byId.values()]
        .filter((item) => item.userId === userId && !isTerminalStatus(item.status))
        .map(cloneRow);
    },
    async listReclaimable(nowMs) {
      return [...byId.values()].filter((item) => isReclaimable(item, nowMs)).map(cloneRow);
    },
    async touchWakes(iso) {
      let n = 0;
      for (const row of byId.values()) {
        if (isTerminalStatus(row.status)) continue;
        row.lastWakeAt = iso;
        n += 1;
      }
      return n;
    },
    async claimLease(runId, owner, nowMs, leaseMs = DURABLE_LEASE_MS) {
      const row = byId.get(runId);
      if (!row) return null;
      if (!canClaimLease(row, nowMs, owner)) return null;
      row.leaseOwner = owner;
      row.leaseExpiresAt = nowMs + leaseMs;
      row.leaseEpoch += 1;
      return cloneRow(row);
    },
    async write(row, expected) {
      const current = byId.get(row.runId);
      if (!current) return false;
      const decision = decideDurableWrite({
        currentRunId: current.runId,
        incomingRunId: row.runId,
        currentGeneration: current.generation,
        currentLeaseEpoch: current.leaseEpoch,
        expectedGeneration: expected.generation,
        expectedLeaseEpoch: expected.leaseEpoch,
        currentStatus: current.status,
        incomingStatus: row.status,
        currentHasSynthesis: hasPersistedSynthesis({
          status: current.status,
          output: current.output,
          responses: current.responses,
          mode: current.frozenInput.task.mode,
        }),
        incomingHasSynthesis: hasPersistedSynthesis({
          status: row.status,
          output: row.output,
          responses: row.responses,
          mode: row.frozenInput.task.mode,
        }),
      });
      if (decision !== "ACCEPT") return false;
      const next = cloneRow(row);
      if (next.lastWakeAt == null) next.lastWakeAt = current.lastWakeAt ?? null;
      if (next.status === "COMPLETE" && current.generation > next.generation) next.generation = current.generation;
      byId.set(row.runId, next);
      return true;
    },
  };
}

export function overlayTaskWithRun(task: Task, row: DurableRunRow, nowMs = Date.now()): Task {
  const pub = toPublic(row, nowMs);
  return {
    ...task,
    status: pub.taskStatus,
    error: row.error,
    provider: row.provider,
    selectedModels: row.members,
    nanogptBilling: row.nanogptBilling,
    diagnostics: {
      ...(task.diagnostics ?? {}),
      run: pub.snapshot,
    },
  };
}
