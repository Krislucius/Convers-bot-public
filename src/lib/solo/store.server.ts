import { getSql } from "@/lib/db";
import { isProviderId } from "@/lib/council/providers";
import type { ProviderId } from "@/lib/council/types";
import { resumeThread, type SoloMessage, type SoloThread, type SoloTransition } from "./logic.ts";

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value ?? []);
}

function mapMessage(row: Record<string, unknown>): SoloMessage {
  return {
    id: asString(row.id),
    threadId: asString(row.thread_id),
    role: asString(row.role) as SoloMessage["role"],
    content: asString(row.content),
    provider: row.provider == null ? null : asString(row.provider),
    modelId: row.model_id == null ? null : asString(row.model_id),
    createdAt: asString(row.created_at),
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    cost: row.cost == null ? null : Number(row.cost),
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    error: row.error == null ? null : asString(row.error),
    citations: Array.isArray(row.citations) ? row.citations.map((item) => String(item)) : [],
    stopped: row.stopped === true || row.stopped === "t" || row.stopped === "true",
  };
}

export async function listSoloThreads(userId: string, projectId: string): Promise<SoloThread[]> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from solo_threads where user_id = ${userId} and project_id = ${projectId} order by updated_at desc
  `;
  const out: SoloThread[] = [];
  for (const row of rows) {
    const thread = await hydrate(userId, row);
    if (thread) out.push(thread);
  }
  return out;
}

export async function loadSoloThread(userId: string, threadId: string): Promise<SoloThread | null> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select * from solo_threads where user_id = ${userId} and id = ${threadId} limit 1
  `;
  return rows[0] ? hydrate(userId, rows[0]) : null;
}

async function hydrate(userId: string, row: Record<string, unknown>): Promise<SoloThread | null> {
  const provider = asString(row.provider);
  if (!isProviderId(provider)) return null;
  const sql = await getSql();
  const messages = await sql<Record<string, unknown>>`
    select * from solo_messages where user_id = ${userId} and thread_id = ${asString(row.id)} order by created_at asc
  `;
  const transitions = Array.isArray(row.transitions) ? (row.transitions as SoloTransition[]) : [];
  return resumeThread({
    id: asString(row.id),
    projectId: asString(row.project_id),
    provider,
    modelId: asString(row.model_id),
    modelLabel: asString(row.model_label) || asString(row.model_id),
    title: asString(row.title) || "Solo",
    contextEnabled: row.context_enabled === true || row.context_enabled === "t" || row.context_enabled === "true",
    selectedChatIds: Array.isArray(row.selected_chat_ids) ? row.selected_chat_ids.map(String) : [],
    selectedFileIds: Array.isArray(row.selected_file_ids) ? row.selected_file_ids.map(String) : [],
    selectedArtifactIds: Array.isArray(row.selected_artifact_ids) ? row.selected_artifact_ids.map(String) : [],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    messages: messages.map(mapMessage),
    transitions,
  });
}

export async function saveSoloThread(userId: string, thread: SoloThread): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into solo_threads (
      id, user_id, project_id, provider, model_id, model_label, title, context_enabled,
      selected_chat_ids, selected_file_ids, selected_artifact_ids, transitions, cancel_requested, created_at, updated_at
    ) values (
      ${thread.id}, ${userId}, ${thread.projectId}, ${thread.provider}, ${thread.modelId}, ${thread.modelLabel},
      ${thread.title}, ${thread.contextEnabled}, ${json(thread.selectedChatIds)}::jsonb, ${json(thread.selectedFileIds)}::jsonb,
      ${json(thread.selectedArtifactIds)}::jsonb, ${json(thread.transitions)}::jsonb, false, ${thread.createdAt}, ${thread.updatedAt}
    )
    on conflict (id) do update set
      provider = excluded.provider,
      model_id = excluded.model_id,
      model_label = excluded.model_label,
      title = excluded.title,
      context_enabled = excluded.context_enabled,
      selected_chat_ids = excluded.selected_chat_ids,
      selected_file_ids = excluded.selected_file_ids,
      selected_artifact_ids = excluded.selected_artifact_ids,
      transitions = excluded.transitions,
      updated_at = excluded.updated_at
    where solo_threads.user_id = ${userId}
  `;
  await sql`delete from solo_messages where user_id = ${userId} and thread_id = ${thread.id}`;
  for (const row of thread.messages) {
    await sql`
      insert into solo_messages (
        id, user_id, thread_id, role, content, provider, model_id, created_at,
        input_tokens, output_tokens, cost, latency_ms, error, citations, stopped
      ) values (
        ${row.id}, ${userId}, ${thread.id}, ${row.role}, ${row.content}, ${row.provider}, ${row.modelId}, ${row.createdAt},
        ${row.inputTokens}, ${row.outputTokens}, ${row.cost}, ${row.latencyMs}, ${row.error}, ${json(row.citations)}::jsonb, ${row.stopped}
      )
    `;
  }
}

export async function setSoloCancel(userId: string, threadId: string, cancelled: boolean): Promise<void> {
  const sql = await getSql();
  await sql`
    update solo_threads set cancel_requested = ${cancelled} where user_id = ${userId} and id = ${threadId}
  `;
}

export async function soloCancelled(userId: string, threadId: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<Record<string, unknown>>`
    select cancel_requested from solo_threads where user_id = ${userId} and id = ${threadId} limit 1
  `;
  const value = rows[0]?.cancel_requested;
  return value === true || value === "t" || value === "true";
}

export async function recordSoloCall(userId: string, input: { provider: ProviderId; modelId: string; threadId: string; cost: number | null; inputTokens: number | null; outputTokens: number | null }): Promise<void> {
  const sql = await getSql();
  const id = `su_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  await sql`
    insert into solo_usage (id, user_id, kind, provider, model_id, thread_id, created_at, cost, input_tokens, output_tokens)
    values (${id}, ${userId}, 'SOLO_CALLS', ${input.provider}, ${input.modelId}, ${input.threadId}, ${new Date().toISOString()}, ${input.cost}, ${input.inputTokens}, ${input.outputTokens})
  `;
}

export async function usageCounts(userId: string): Promise<{ soloCalls: number; councilCalls: number }> {
  const sql = await getSql();
  const solo = await sql<Record<string, unknown>>`select count(*)::int as n from solo_usage where user_id = ${userId} and kind = 'SOLO_CALLS'`;
  const council = await sql<Record<string, unknown>>`select count(*)::int as n from agent_responses where user_id = ${userId}`;
  return { soloCalls: Number(solo[0]?.n ?? 0), councilCalls: Number(council[0]?.n ?? 0) };
}
