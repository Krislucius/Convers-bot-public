import type { CouncilCompleteChat, CouncilRuntime } from "./orchestrate.ts";
import type { AgentResponse, ProviderId } from "./types.ts";
import { isProviderId, normalizeProviderId } from "./providers.ts";
import { normalizeNanoGptBilling, type NanoGptBillingMode } from "./nano-billing.ts";
import { formatProviderFailure, toProviderFailure } from "./provider-error.ts";
import {
  isTerminalStatus,
  overlayTaskWithRun,
  toPublic,
  type DurableFrozenInput,
  type DurableRunPublic,
} from "./durable-run.ts";
import {
  driveDurableRun,
  getDurableRun,
  restartDurableRun,
  startDurableRun,
  stopDurableRun,
  tickDurableRun,
} from "./durable-engine.ts";
import { MAX_DORMANT_MS, SWEEP_INTERVAL_MS } from "./durable-run.ts";
import { createSqlDurableStore, loadRunByToken } from "./durable-store.server.ts";
import { persistCouncilCheckpoint, persistCouncilOutput } from "./account.server.ts";
import type { CouncilMember } from "./members.ts";
import type { DiscoveredModel, DiscoverySnapshot } from "./discover.ts";

const store = createSqlDurableStore();

async function loadProvider(id: ProviderId) {
  if (id === "openrusrouter") return import("./openrusrouter.server.ts");
  if (id === "openrouter") return import("./openrouter.server.ts");
  return import("./nanogpt.server.ts");
}

function billingArg(provider: ProviderId, value?: NanoGptBillingMode): NanoGptBillingMode | undefined {
  return provider === "nanogpt" ? normalizeNanoGptBilling(value) : undefined;
}

export async function freezeFromAccount(
  userId: string,
  data: {
    taskId: string;
    provider: ProviderId;
    members: CouncilMember[];
    synthesizerModel: string;
    maxCostUsd: number;
    nanogptBilling?: NanoGptBillingMode;
    catalog?: DiscoveredModel[];
    scan?: DiscoverySnapshot | null;
    resumeResponses?: AgentResponse[];
  },
): Promise<DurableFrozenInput> {
  const account = await import("./account.server.ts");
  const snapshot = await account.loadSnapshot(userId);
  const task = snapshot.tasks.find((row) => row.id === data.taskId);
  if (!task) throw new Error("Task not found.");
  const project = snapshot.projects.find((row) => row.id === task.projectId);
  if (!project) throw new Error("Project not found.");
  const parentPacket =
    task.mode === "CREATE"
      ? snapshot.packets.filter((row) => row.projectId === project.id && row.status === "READY").at(-1) ?? null
      : snapshot.packets.find((row) => row.reviewTaskId === task.id) ?? null;
  const frozenTask = {
    ...task,
    provider: data.provider,
    selectedModels: data.members,
    nanogptBilling: data.nanogptBilling ?? null,
    status: "PREPARING" as const,
    error: null,
  };
  await account.persistTask(userId, frozenTask);
  return {
    project: { id: project.id, name: project.name, description: project.description },
    task: frozenTask,
    context: snapshot.context.filter((row) => row.projectId === project.id),
    chatSources: snapshot.chatSources,
    historyMessages: snapshot.historyMessages,
    projectFiles: snapshot.projectFiles,
    artifacts: snapshot.artifacts.filter((row) => row.projectId === project.id),
    parentPacket,
    catalog: data.catalog,
    scan: data.scan ?? null,
    resumeResponses: data.resumeResponses,
    members: data.members,
    synthesizerModel: data.synthesizerModel,
    maxCostUsd: data.maxCostUsd,
    provider: data.provider,
    nanogptBilling: data.nanogptBilling,
  };
}

export async function providerRuntime(userId: string, provider: ProviderId, billing?: NanoGptBillingMode): Promise<CouncilRuntime> {
  const { resolveStoredKey } = await import("./account.server.ts");
  const apiKey = await resolveStoredKey(userId, provider, "");
  const mod = await loadProvider(provider);
  const completeChat: CouncilCompleteChat = async (opts) => {
    if (!apiKey) return { ok: false, error: "The AI provider is not connected. Save an API key on this account first." };
    try {
      const completion = await mod.complete({
        apiKey,
        model: opts.model,
        messages: opts.messages,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        responseFormat: opts.responseFormat,
        nanogptBilling: billingArg(provider, opts.nanogptBilling ?? billing),
      });
      return { ok: true, completion };
    } catch (err) {
      const failure = toProviderFailure(err, { provider, model: opts.model, stage: "complete" }, apiKey);
      return { ok: false, error: formatProviderFailure(failure), failure };
    }
  };
  return {
    completeChat,
    catalogCheck: async (opts) => {
      if (!apiKey) {
        return {
          ok: false,
          code: "KEY_REJECTED",
          error: "The AI provider is not connected. Save an API key on this account first.",
          missing: opts.models,
          available: [],
        };
      }
      return mod.catalogCheck({
        apiKey,
        models: opts.models,
        nanogptBilling: billingArg(provider, opts.nanogptBilling ?? billing),
      });
    },
    accessCheck: async (opts) => {
      if (!apiKey) {
        return {
          ok: false,
          blocked: opts.models.map((id) => ({ id, access: "UNAVAILABLE" })),
          error: "The AI provider is not connected. Save an API key on this account first.",
        };
      }
      return mod.accessCheck({
        apiKey,
        models: opts.models,
        nanogptBilling: billingArg(provider, opts.nanogptBilling ?? billing),
      });
    },
  };
}

async function persistTerminal(userId: string, publicRun: DurableRunPublic | null): Promise<void> {
  if (!publicRun?.output) return;
  try {
    await persistCouncilOutput(userId, {
      task: {
        ...publicRun.output.task,
        diagnostics: {
          ...(publicRun.output.task.diagnostics ?? {}),
          run: publicRun.snapshot,
        },
      },
      responses: publicRun.output.responses,
      result: publicRun.output.result,
      artifact: publicRun.output.artifact,
      manifest: publicRun.output.manifest,
      packet: publicRun.output.packet,
    });
  } catch (err) {
    console.error("[council.durable] persist terminal", err);
  }
}

async function persistProgress(userId: string, publicRun: DurableRunPublic | null): Promise<void> {
  if (!publicRun) return;
  try {
    const snapshot = await (await import("./account.server.ts")).loadSnapshot(userId);
    const task = snapshot.tasks.find((row) => row.id === publicRun.taskId);
    if (!task) return;
    const live = await store.get(publicRun.runId);
    if (!live) return;
    await persistCouncilCheckpoint(userId, {
      task: overlayTaskWithRun(task, live),
      responses: publicRun.responses,
      result: publicRun.output?.result ?? null,
      artifact: publicRun.output?.artifact,
      manifest: publicRun.output?.manifest,
      packet: publicRun.output?.packet,
    });
  } catch (err) {
    console.error("[council.durable] persist progress", err);
  }
}

export async function scheduleBackground(work: () => Promise<void>): Promise<void> {
  const task = Promise.resolve()
    .then(work)
    .catch((err) => {
      console.error("[council.durable]", err);
    });
  try {
    const vf = await import("@vercel/functions");
    if (typeof vf.waitUntil === "function") {
      vf.waitUntil(task);
      return;
    }
  } catch {
    /* not on Vercel */
  }
  void task;
}

function tickOrigin(): string {
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return vercel.startsWith("http") ? vercel : `https://${vercel}`;
  const auth = process.env.BETTER_AUTH_URL?.trim();
  if (auth) return auth.replace(/\/$/, "");
  return "http://127.0.0.1:8080";
}

async function scheduleSelfTick(runId: string, token: string): Promise<void> {
  const url = `${tickOrigin()}/api/council/tick`;
  await scheduleBackground(async () => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, token }),
      });
    } catch (err) {
      console.error("[council.durable] self-tick", err);
    }
  });
}

export async function enqueueCouncilRun(runId: string): Promise<void> {
  const vercel = Boolean(process.env.VERCEL);
  await scheduleBackground(async () => {
    const row = await store.get(runId);
    if (!row || isTerminalStatus(row.status)) return;
    const runtime = await providerRuntime(row.userId, row.provider, row.nanogptBilling ?? undefined);
    if (vercel) {
      const started = Date.now();
      const result = await tickDurableRun(store, { runId, owner: `tick-${started}`, runtime });
      if (result.public) await persistProgress(row.userId, result.public);
      if (result.terminal) {
        await persistTerminal(row.userId, result.public);
        return;
      }
      const latest = await store.get(runId);
      if (latest && !isTerminalStatus(latest.status)) await scheduleSelfTick(latest.runId, latest.tickToken);
      return;
    }
    const done = await driveDurableRun(store, {
      runId,
      owner: `proc-${process.pid}`,
      runtime,
      maxTicks: 64,
    });
    if (done) await persistProgress(row.userId, done);
    if (done && isTerminalStatus(done.status)) await persistTerminal(row.userId, done);
  });
}

export async function startServerCouncilRun(input: {
  userId: string;
  taskId: string;
  frozen: DurableFrozenInput;
  force?: boolean;
}): Promise<DurableRunPublic> {
  const publicRun = await startDurableRun(store, input);
  const row = await store.get(publicRun.runId);
  if (row && !isTerminalStatus(row.status)) await enqueueCouncilRun(row.runId);
  return publicRun;
}

export async function stopServerCouncilRun(input: {
  userId: string;
  taskId: string;
  runId?: string;
}): Promise<DurableRunPublic | null> {
  const stopped = await stopDurableRun(store, input);
  if (stopped) await persistProgress(input.userId, stopped);
  return stopped;
}

export async function restartServerCouncilRun(input: {
  userId: string;
  taskId: string;
  frozen: DurableFrozenInput;
}): Promise<DurableRunPublic> {
  const publicRun = await restartDurableRun(store, input);
  const row = await store.get(publicRun.runId);
  if (row && !isTerminalStatus(row.status)) await enqueueCouncilRun(row.runId);
  return publicRun;
}

export async function getServerCouncilRun(input: {
  userId: string;
  taskId?: string;
  runId?: string;
}): Promise<DurableRunPublic | null> {
  let row = input.runId ? await store.get(input.runId) : null;
  if (!row && input.taskId) row = await store.getActive(input.userId, input.taskId);
  if (!row || row.userId !== input.userId) return null;
  if (!isTerminalStatus(row.status)) {
    const expired = !row.leaseExpiresAt || row.leaseExpiresAt <= Date.now();
    if (expired) await enqueueCouncilRun(row.runId);
  }
  return toPublic(row);
}

export async function tickByToken(runId: string, token: string): Promise<DurableRunPublic | null> {
  const authorized = await loadRunByToken(runId, token);
  if (!authorized) return null;
  if (isTerminalStatus(authorized.status)) return toPublic(authorized);
  await enqueueCouncilRun(authorized.runId);
  return getDurableRun(store, authorized.runId);
}

export async function sweepServerCouncilRuns(): Promise<{
  wokenAt: string;
  considered: number;
  reclaimed: number;
  runIds: string[];
  intervalMs: number;
  maxDormantMs: number;
}> {
  const { ensureProcessWaker } = await import("./durable-waker.server.ts");
  ensureProcessWaker();
  const nowMs = Date.now();
  const wokenAt = new Date(nowMs).toISOString();
  await store.touchWakes(wokenAt);
  const reclaimable = await store.listReclaimable(nowMs);
  const runIds: string[] = [];
  for (const row of reclaimable) {
    await enqueueCouncilRun(row.runId);
    runIds.push(row.runId);
  }
  return {
    wokenAt,
    considered: reclaimable.length,
    reclaimed: runIds.length,
    runIds,
    intervalMs: SWEEP_INTERVAL_MS,
    maxDormantMs: MAX_DORMANT_MS,
  };
}

export function normalizeRunProvider(value: unknown): ProviderId {
  return isProviderId(value) ? value : normalizeProviderId(value);
}
