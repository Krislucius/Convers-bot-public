import { getSql } from "@/lib/db";
import { ensureMembers } from "./members.ts";
import { normalizeNanoGptBilling } from "./nano-billing.ts";
import { isProviderId } from "./providers.ts";
import {
  DURABLE_LEASE_MS,
  OneActiveRunError,
  canClaimLease,
  cloneRow,
  emptyCursor,
  isTerminalStatus,
  shouldAcceptDurableWrite,
  type DurableCursor,
  type DurableFrozenInput,
  type DurableRunRow,
  type DurableStage,
  type DurableStatus,
  type DurableStore,
} from "./durable-run.ts";
import type { CouncilRunSnapshot } from "./run-control.ts";
import type { AgentResponse, RunCouncilOutput } from "./types.ts";

function asJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function asString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  return String(value);
}

function asNum(value: unknown, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

function jsonParam(value: unknown): string | null {
  if (value == null) return null;
  return JSON.stringify(value);
}

function mapRow(raw: Record<string, unknown>): DurableRunRow {
  const providerRaw = asString(raw.provider, "nanogpt");
  const provider = isProviderId(providerRaw) ? providerRaw : "nanogpt";
  const members = ensureMembers(asJson(raw.members, []));
  const cursor = { ...emptyCursor(), ...asJson<DurableCursor>(raw.cursor, emptyCursor()) };
  const frozen = asJson<DurableFrozenInput>(raw.frozen_input, {
    project: { id: "", name: "", description: "" },
    task: { id: asString(raw.task_id), projectId: "", title: "", prompt: "", status: "CREATED", error: null, createdAt: "", completedAt: null, totalInputTokens: null, totalOutputTokens: null, totalCostUsd: null, totalLatencyMs: null, diagnostics: null, selectedChatSourceIds: [], selectedFileIds: [], mode: "DECIDE", requiresHistoricalContext: false, candidateArtifactId: null, decisionQuestion: null, contextManifestId: null, contextHash: null, provider },
    context: [],
    chatSources: [],
    historyMessages: [],
    projectFiles: [],
    artifacts: [],
    parentPacket: null,
    members,
    synthesizerModel: asString(raw.synthesizer_model),
    maxCostUsd: 1,
    provider,
  });
  const snapshot = asJson<CouncilRunSnapshot>(raw.snapshot, {
    runId: asString(raw.id),
    generation: asNum(raw.generation, 1),
    stage: "PREPARING",
    status: "PREPARING",
    startedAt: asString(raw.started_at),
    stageStartedAt: asString(raw.started_at),
    updatedAt: asString(raw.last_progress_at),
    agents: {},
    message: "",
  });
  const extra = asJson<{ responses?: AgentResponse[]; output?: RunCouncilOutput | null }>(raw.snapshot, {});
  return {
    runId: asString(raw.id),
    userId: asString(raw.user_id),
    taskId: asString(raw.task_id),
    generation: asNum(raw.generation, 1),
    leaseEpoch: asNum(raw.lease_epoch, 0),
    status: asString(raw.status, "QUEUED") as DurableStatus,
    stage: asString(raw.stage, "QUEUED") as DurableStage,
    cancelRequested: asBool(raw.cancel_requested),
    leaseOwner: raw.lease_owner == null ? null : asString(raw.lease_owner),
    leaseExpiresAt: raw.lease_expires_at == null || raw.lease_expires_at === "" ? null : asNum(raw.lease_expires_at, Date.parse(asString(raw.lease_expires_at))),
    tickToken: asString(raw.tick_token),
    cursor,
    snapshot,
    frozenInput: frozen,
    contextHash: raw.context_hash == null ? null : asString(raw.context_hash),
    provider,
    nanogptBilling: raw.nanogpt_billing_mode ? normalizeNanoGptBilling(raw.nanogpt_billing_mode) : null,
    members: frozen.members?.length ? ensureMembers(frozen.members) : members,
    synthesizerModel: asString(raw.synthesizer_model),
    catalog: frozen.catalog ?? null,
    startedAt: asString(raw.started_at),
    lastProgressAt: asString(raw.last_progress_at),
    completedAt: raw.completed_at == null ? null : asString(raw.completed_at),
    error: raw.error == null ? null : asString(raw.error),
    createdAt: asString(raw.created_at),
    responses: extra.responses ?? frozen.resumeResponses ?? [],
    output: extra.output ?? null,
  };
}

async function durable(): Promise<void> {
  const { checkpointPglite } = await import("@/lib/db");
  await checkpointPglite();
}

export function snapshotBlob(row: DurableRunRow): string {
  return JSON.stringify({ ...row.snapshot, responses: row.responses, output: row.output });
}

async function insertRow(row: DurableRunRow): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into council_runs (
      id, user_id, task_id, generation, lease_epoch, status, stage, cancel_requested,
      lease_owner, lease_expires_at, tick_token, cursor, snapshot, frozen_input, context_hash,
      provider, nanogpt_billing_mode, members, synthesizer_model, catalog,
      started_at, last_progress_at, completed_at, error, created_at
    ) values (
      ${row.runId}, ${row.userId}, ${row.taskId}, ${row.generation}, ${row.leaseEpoch}, ${row.status}, ${row.stage},
      ${row.cancelRequested}, ${row.leaseOwner}, ${row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt)},
      ${row.tickToken}, ${jsonParam(row.cursor)}::jsonb, ${snapshotBlob(row)}::jsonb, ${jsonParam(row.frozenInput)}::jsonb,
      ${row.contextHash}, ${row.provider}, ${row.nanogptBilling}, ${jsonParam(row.members)}::jsonb,
      ${row.synthesizerModel}, ${jsonParam(row.catalog)}::jsonb, ${row.startedAt}, ${row.lastProgressAt},
      ${row.completedAt}, ${row.error}, ${row.createdAt}
    )
  `;
}

async function updateRow(row: DurableRunRow, expected: { generation: number; leaseEpoch: number }): Promise<boolean> {
  const sql = await getSql();
  const updated = await sql<{ id: string }>`
    update council_runs set
      generation = ${row.generation},
      lease_epoch = ${row.leaseEpoch},
      status = ${row.status},
      stage = ${row.stage},
      cancel_requested = ${row.cancelRequested},
      lease_owner = ${row.leaseOwner},
      lease_expires_at = ${row.leaseExpiresAt == null ? null : String(row.leaseExpiresAt)},
      cursor = ${jsonParam(row.cursor)}::jsonb,
      snapshot = ${snapshotBlob(row)}::jsonb,
      frozen_input = ${jsonParam(row.frozenInput)}::jsonb,
      context_hash = ${row.contextHash},
      last_progress_at = ${row.lastProgressAt},
      completed_at = ${row.completedAt},
      error = ${row.error}
    where id = ${row.runId}
      and generation = ${expected.generation}
      and lease_epoch = ${expected.leaseEpoch}
    returning id
  `;
  return updated.length > 0;
}

export function createSqlDurableStore(): DurableStore {
  return {
    async insert(row) {
      const active = await this.getActive(row.userId, row.taskId);
      if (active) throw new OneActiveRunError(active.runId);
      try {
        await insertRow(row);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/council_runs_one_active_per_task|unique/i.test(message)) {
          const live = await this.getActive(row.userId, row.taskId);
          throw new OneActiveRunError(live?.runId ?? row.runId);
        }
        throw err;
      }
      await durable();
      return cloneRow(row);
    },
    async get(runId) {
      const sql = await getSql();
      const rows = await sql`select * from council_runs where id = ${runId} limit 1`;
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async getActive(userId, taskId) {
      const sql = await getSql();
      const rows = await sql`
        select * from council_runs
        where user_id = ${userId} and task_id = ${taskId}
          and status not in ('COMPLETE', 'FAILED', 'CANCELLED')
        order by created_at desc
        limit 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async listActive(userId) {
      const sql = await getSql();
      const rows = await sql`
        select * from council_runs
        where user_id = ${userId}
          and status not in ('COMPLETE', 'FAILED', 'CANCELLED')
        order by last_progress_at desc
      `;
      return rows.map(mapRow);
    },
    async claimLease(runId, owner, nowMs, leaseMs = DURABLE_LEASE_MS) {
      const current = await this.get(runId);
      if (!current) return null;
      if (!canClaimLease(current, nowMs, owner)) return null;
      const next = cloneRow(current);
      next.leaseOwner = owner;
      next.leaseExpiresAt = nowMs + leaseMs;
      next.leaseEpoch += 1;
      const ok = await updateRow(next, { generation: current.generation, leaseEpoch: current.leaseEpoch });
      if (!ok) return null;
      await durable();
      return next;
    },
    async write(row, expected) {
      const current = await this.get(row.runId);
      if (!current) return false;
      if (!shouldAcceptDurableWrite(current, { runId: row.runId, ...expected })) return false;
      const ok = await updateRow(row, expected);
      if (ok) await durable();
      return ok;
    },
  };
}

export async function loadRunByToken(runId: string, token: string): Promise<DurableRunRow | null> {
  const sql = await getSql();
  const rows = await sql`select * from council_runs where id = ${runId} and tick_token = ${token} limit 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listActiveRuns(userId: string): Promise<DurableRunRow[]> {
  return createSqlDurableStore().listActive(userId);
}

export { isTerminalStatus };
