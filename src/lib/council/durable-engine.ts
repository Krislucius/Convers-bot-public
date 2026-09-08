import type { CouncilRuntime } from "./orchestrate.ts";
import { ensureMembers } from "./members.ts";
import { normalizeNanoGptBilling } from "./nano-billing.ts";
import { advanceDurableStep, applyStopToRow } from "./durable-step.ts";
import {
  DURABLE_LEASE_MS,
  OneActiveRunError,
  cloneRow,
  emptyCursor,
  initialSnapshot,
  isTerminalStatus,
  newRunId,
  newTickToken,
  toPublic,
  waitingAgents,
  type DurableFrozenInput,
  type DurableRunPublic,
  type DurableRunRow,
  type DurableStore,
} from "./durable-run.ts";
import { CouncilCancelled } from "./run-control.ts";

export type StartDurableRunInput = {
  userId: string;
  taskId: string;
  frozen: DurableFrozenInput;
  force?: boolean;
  now?: () => string;
};

export type TickResult = {
  public: DurableRunPublic | null;
  skipped: boolean;
  reason?: "LEASE_HELD" | "MISSING" | "TERMINAL" | "STALE_WRITE";
  terminal: boolean;
  didProviderCall: boolean;
};

const inflight = new Map<string, AbortController>();

export function abortInflight(runId: string): void {
  const current = inflight.get(runId);
  if (current) {
    current.abort();
    inflight.delete(runId);
  }
}

export function resetInflight(): void {
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();
}

function iso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

export function buildQueuedRow(input: StartDurableRunInput): DurableRunRow {
  const startedAt = iso(input.now);
  const members = ensureMembers(input.frozen.members);
  const runId = newRunId();
  const billing =
    input.frozen.provider === "nanogpt" ? normalizeNanoGptBilling(input.frozen.nanogptBilling) : null;
  const generation = 1;
  return {
    runId,
    userId: input.userId,
    taskId: input.taskId,
    generation,
    leaseEpoch: 0,
    status: "QUEUED",
    stage: "QUEUED",
    cancelRequested: false,
    leaseOwner: null,
    leaseExpiresAt: null,
    tickToken: newTickToken(),
    cursor: emptyCursor(),
    snapshot: initialSnapshot({
      runId,
      generation,
      members,
      provider: input.frozen.provider,
      synthesizerModel: input.frozen.synthesizerModel,
      nanogptBilling: billing,
      startedAt,
    }),
    frozenInput: { ...input.frozen, members, nanogptBilling: billing ?? undefined },
    contextHash: null,
    provider: input.frozen.provider,
    nanogptBilling: billing,
    members,
    synthesizerModel: input.frozen.synthesizerModel,
    catalog: input.frozen.catalog ?? null,
    startedAt,
    lastProgressAt: startedAt,
    lastWakeAt: null,
    completedAt: null,
    error: null,
    createdAt: startedAt,
    responses: [],
    output: null,
  };
}

export async function startDurableRun(store: DurableStore, input: StartDurableRunInput): Promise<DurableRunPublic> {
  const existing = await store.getActive(input.userId, input.taskId);
  if (existing && !input.force) return toPublic(existing);
  if (existing && input.force) {
    abortInflight(existing.runId);
    const now = iso(input.now);
    const expected = { generation: existing.generation, leaseEpoch: existing.leaseEpoch };
    const sealed = applyStopToRow(existing, now);
    if (sealed.status === "COMPLETE" || sealed.status === "FAILED") {
      await store.write(sealed, expected);
    } else {
      existing.cancelRequested = true;
      existing.generation += 1;
      existing.leaseOwner = null;
      existing.leaseExpiresAt = null;
      existing.status = "CANCELLED";
      existing.stage = "CANCELLED";
      existing.completedAt = now;
      existing.error = "Council run stopped.";
      existing.snapshot = {
        ...existing.snapshot,
        generation: existing.generation,
        stage: "CANCELLED",
        status: "CANCELLED",
        updatedAt: now,
        message: "Council run stopped.",
      };
      await store.write(existing, { generation: existing.generation - 1, leaseEpoch: existing.leaseEpoch });
    }
  }
  const row = buildQueuedRow(input);
  try {
    await store.insert(row);
  } catch (err) {
    if (err instanceof OneActiveRunError) {
      const live = await store.get(err.existingRunId);
      if (live) return toPublic(live);
    }
    throw err;
  }
  return toPublic(row);
}

export async function stopDurableRun(
  store: DurableStore,
  opts: { userId: string; taskId: string; runId?: string; now?: () => string },
): Promise<DurableRunPublic | null> {
  const row = opts.runId ? await store.get(opts.runId) : await store.getActive(opts.userId, opts.taskId);
  if (!row || row.userId !== opts.userId) return null;
  if (isTerminalStatus(row.status)) return toPublic(row);
  abortInflight(row.runId);
  const now = iso(opts.now);
  const expected = { generation: row.generation, leaseEpoch: row.leaseEpoch };
  const sealed = applyStopToRow(row, now);
  if (sealed.status === "COMPLETE" || sealed.status === "FAILED") {
    const ok = await store.write(sealed, expected);
    if (!ok) {
      const latest = await store.get(row.runId);
      return latest ? toPublic(latest) : null;
    }
    return toPublic(sealed);
  }
  row.cancelRequested = true;
  row.generation += 1;
  row.leaseOwner = null;
  row.leaseExpiresAt = null;
  row.status = "CANCELLED";
  row.stage = "CANCELLED";
  row.completedAt = now;
  row.lastProgressAt = now;
  row.error = "Council run stopped.";
  const agents = { ...(row.snapshot.agents ?? waitingAgents(row.members)) };
  for (const member of row.members) {
    const current = agents[member.memberId];
    if (current?.state === "WAITING" || current?.state === "RUNNING") {
      agents[member.memberId] = { ...current, state: "FAILED", error: "Council run stopped." };
    }
  }
  row.snapshot = {
    ...row.snapshot,
    generation: row.generation,
    stage: "CANCELLED",
    status: "CANCELLED",
    updatedAt: now,
    message: "Council run stopped.",
    agents,
  };
  const ok = await store.write(row, expected);
  if (!ok) {
    const latest = await store.get(row.runId);
    return latest ? toPublic(latest) : null;
  }
  return toPublic(row);
}

export async function restartDurableRun(store: DurableStore, input: StartDurableRunInput): Promise<DurableRunPublic> {
  return startDurableRun(store, { ...input, force: true });
}

export async function tickDurableRun(
  store: DurableStore,
  opts: {
    runId: string;
    owner: string;
    runtime: CouncilRuntime;
    nowMs?: number;
    now?: () => string;
    leaseMs?: number;
    signal?: AbortSignal;
  },
): Promise<TickResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const claimed = await store.claimLease(opts.runId, opts.owner, nowMs, opts.leaseMs ?? DURABLE_LEASE_MS);
  if (!claimed) {
    const latest = await store.get(opts.runId);
    if (!latest) return { public: null, skipped: true, reason: "MISSING", terminal: true, didProviderCall: false };
    if (isTerminalStatus(latest.status)) {
      return { public: toPublic(latest), skipped: true, reason: "TERMINAL", terminal: true, didProviderCall: false };
    }
    return { public: toPublic(latest), skipped: true, reason: "LEASE_HELD", terminal: false, didProviderCall: false };
  }
  if (claimed.cancelRequested) {
    const stopped = await stopDurableRun(store, { userId: claimed.userId, taskId: claimed.taskId, runId: claimed.runId, now: opts.now });
    return { public: stopped, skipped: false, terminal: true, didProviderCall: false };
  }
  const expected = { generation: claimed.generation, leaseEpoch: claimed.leaseEpoch };
  const controller = new AbortController();
  const parent = opts.signal;
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", () => controller.abort(), { once: true });
  }
  inflight.set(claimed.runId, controller);
  try {
    const stepped = await advanceDurableStep({
      row: claimed,
      runtime: opts.runtime,
      signal: controller.signal,
      now: opts.now,
      nowMs,
    });
    stepped.row.leaseOwner = null;
    stepped.row.leaseExpiresAt = null;
    const written = await store.write(stepped.row, expected);
    if (!written) {
      const latest = await store.get(opts.runId);
      return {
        public: latest ? toPublic(latest) : null,
        skipped: true,
        reason: "STALE_WRITE",
        terminal: latest ? isTerminalStatus(latest.status) : true,
        didProviderCall: stepped.didProviderCall,
      };
    }
    return {
      public: toPublic(stepped.row),
      skipped: false,
      terminal: stepped.terminal,
      didProviderCall: stepped.didProviderCall,
    };
  } catch (err) {
    if (err instanceof CouncilCancelled || controller.signal.aborted) {
      const stopped = await stopDurableRun(store, {
        userId: claimed.userId,
        taskId: claimed.taskId,
        runId: claimed.runId,
        now: opts.now,
      });
      return { public: stopped, skipped: false, terminal: true, didProviderCall: false };
    }
    throw err;
  } finally {
    if (inflight.get(claimed.runId) === controller) inflight.delete(claimed.runId);
  }
}

export async function driveDurableRun(
  store: DurableStore,
  opts: {
    runId: string;
    owner: string;
    runtime: CouncilRuntime;
    maxTicks?: number;
    now?: () => string;
    clock?: () => number;
  },
): Promise<DurableRunPublic | null> {
  const maxTicks = opts.maxTicks ?? 64;
  let last: DurableRunPublic | null = null;
  for (let i = 0; i < maxTicks; i += 1) {
    const result = await tickDurableRun(store, {
      runId: opts.runId,
      owner: opts.owner,
      runtime: opts.runtime,
      now: opts.now,
      nowMs: opts.clock?.(),
    });
    last = result.public;
    if (result.terminal) return last;
    if (result.skipped && result.reason === "LEASE_HELD") return last;
    if (result.skipped && result.reason === "STALE_WRITE") return last;
  }
  return last;
}

export async function getDurableRun(store: DurableStore, runId: string): Promise<DurableRunPublic | null> {
  const row = await store.get(runId);
  return row ? toPublic(row) : null;
}

export type SweepDurableResult = {
  wokenAt: string;
  considered: number;
  reclaimed: number;
  skipped: number;
  results: TickResult[];
};

export async function sweepDurableRuns(
  store: DurableStore,
  opts: {
    runtime: CouncilRuntime;
    owner?: string;
    nowMs?: number;
    now?: () => string;
    leaseMs?: number;
  },
): Promise<SweepDurableResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const wokenAt = opts.now?.() ?? new Date(nowMs).toISOString();
  await store.touchWakes(wokenAt);
  const reclaimable = await store.listReclaimable(nowMs);
  const results: TickResult[] = [];
  let reclaimed = 0;
  let skipped = 0;
  const owner = opts.owner ?? `sweep-${nowMs}`;
  for (const row of reclaimable) {
    const tick = await tickDurableRun(store, {
      runId: row.runId,
      owner,
      runtime: opts.runtime,
      nowMs,
      now: opts.now,
      leaseMs: opts.leaseMs,
    });
    results.push(tick);
    if (tick.skipped) skipped += 1;
    else reclaimed += 1;
  }
  return { wokenAt, considered: reclaimable.length, reclaimed, skipped, results };
}

export { cloneRow, toPublic };
