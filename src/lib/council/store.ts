import { useSyncExternalStore } from "react";
import {
  persistAccountChat,
  persistAccountChatPatch,
  persistAccountContext,
  persistAccountCouncil,
  persistAccountDeleteChat,
  persistAccountDeleteFile,
  persistAccountFile,
  persistAccountManifest,
  persistAccountPacket,
  persistAccountProject,
  persistAccountTask,
} from "./account";
import { applyRemoteAccessChange, filterSelectedForProject, memoryChatIds } from "@/lib/history/provenance";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";
import type { AccessStatus, ImportStatus } from "@/lib/history/types";
import { normalizeTaskMode } from "./task-mode";
import { artifactStatusForReview, reviewVerdictFor } from "./review";
import {
  applyPacketReview,
  handOffPacket,
  openPacketReview,
  recordImplementation,
} from "./packet";
import type {
  Artifact,
  ContextItem,
  ContextManifest,
  CouncilResult,
  ImplementationPacket,
  ImplementationStatus,
  Project,
  ProjectFile,
  StoreShape,
  Task,
  TaskMode,
  AgentResponse,
} from "./types";

export const LEGACY_STORE_KEY = "conversation-bot:v012";

const empty: StoreShape = {
  projects: [],
  context: [],
  tasks: [],
  responses: [],
  results: [],
  chatSources: [],
  historyMessages: [],
  projectFiles: [],
  artifacts: [],
  manifests: [],
  packets: [],
};

const listeners = new Set<() => void>();
let memory: StoreShape = empty;
let accountBound = false;
let persistQueue: Promise<void> = Promise.resolve();

function nid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 32);
}

function normalizeChatSource(
  source: ChatSource,
  selectedAnywhere: Set<string>,
): ChatSource {
  const archived = source.importStatus === "ARCHIVED";
  const explicit = source.includeInMemory;
  const inferred = explicit === true ? true : explicit === false ? false : selectedAnywhere.has(source.id);
  return {
    ...source,
    includeInMemory: inferred && !archived,
  };
}

function normalizeTask(task: Task): Task {
  const mode = normalizeTaskMode(task.mode);
  return {
    ...task,
    selectedChatSourceIds: Array.isArray(task.selectedChatSourceIds) ? task.selectedChatSourceIds : [],
    selectedFileIds: Array.isArray(task.selectedFileIds) ? task.selectedFileIds : [],
    mode,
    requiresHistoricalContext: Boolean(task.requiresHistoricalContext ?? mode === "CREATE"),
    candidateArtifactId: task.candidateArtifactId ?? null,
    decisionQuestion: task.decisionQuestion ?? null,
    contextManifestId: task.contextManifestId ?? null,
    contextHash: task.contextHash ?? null,
  };
}

function normalizeResponse(row: AgentResponse): AgentResponse {
  return {
    ...row,
    contextManifestId: row.contextManifestId ?? null,
    contextHash: row.contextHash ?? null,
  };
}

function normalizeResult(row: CouncilResult): CouncilResult {
  return {
    ...row,
    decision: row.decision ?? null,
    rationale: row.rationale ?? null,
    dissent: Array.isArray(row.dissent) ? row.dissent : [],
    reviewVerdict: row.reviewVerdict ?? null,
    alternatives: Array.isArray(row.alternatives) ? row.alternatives : [],
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    risks: Array.isArray(row.risks) ? row.risks : [],
    issues: Array.isArray(row.issues) ? row.issues : [],
    proposedCorrections: Array.isArray(row.proposedCorrections) ? row.proposedCorrections : [],
    resolvedIssues: Array.isArray(row.resolvedIssues) ? row.resolvedIssues : [],
    unresolvedIssues: Array.isArray(row.unresolvedIssues) ? row.unresolvedIssues : [],
    citations: Array.isArray(row.citations) ? row.citations : [],
    failedAgents: Array.isArray(row.failedAgents) ? row.failedAgents : [],
  };
}

function normalize(parsed: Partial<StoreShape>): StoreShape {
  const tasks = (parsed.tasks ?? []).map(normalizeTask);
  const selectedAnywhere = new Set(tasks.flatMap((task) => task.selectedChatSourceIds));
  return {
    projects: parsed.projects ?? [],
    context: parsed.context ?? [],
    tasks,
    responses: (parsed.responses ?? []).map(normalizeResponse),
    results: (parsed.results ?? []).map(normalizeResult),
    chatSources: (parsed.chatSources ?? []).map((source) => normalizeChatSource(source, selectedAnywhere)),
    historyMessages: parsed.historyMessages ?? [],
    projectFiles: parsed.projectFiles ?? [],
    artifacts: parsed.artifacts ?? [],
    manifests: parsed.manifests ?? [],
    packets: parsed.packets ?? [],
  };
}

export function readLegacyLocalStore(): StoreShape | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    if (!parsed.projects?.length) return null;
    return normalize(parsed);
  } catch {
    return null;
  }
}

function persist(next: StoreShape) {
  memory = next;
  listeners.forEach((fn) => fn());
}

function enqueue(op: () => Promise<unknown>) {
  if (!accountBound || typeof window === "undefined") return;
  persistQueue = persistQueue
    .then(async () => {
      await op();
    })
    .catch((err) => {
      console.error("[account] persist failed", err);
    });
}

export function hydrateStore(next: StoreShape) {
  persist(normalize(next));
}

export function resetStore() {
  accountBound = false;
  persist(empty);
}

export function bindAccountStore() {
  accountBound = true;
}

function snapshot(): StoreShape {
  return memory;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore(): StoreShape {
  return useSyncExternalStore(subscribe, snapshot, () => empty);
}

export function getStoreSnapshot(): StoreShape {
  return memory;
}

export function createProject(name: string, description: string): Project {
  const project: Project = {
    id: nid(),
    name,
    description,
    createdAt: new Date().toISOString(),
  };
  persist({ ...memory, projects: [project, ...memory.projects] });
  enqueue(() => persistAccountProject({ data: project }));
  return project;
}

export function addContext(
  projectId: string,
  kind: ContextItem["kind"],
  content: string,
  status: ContextItem["status"],
  source: ContextItem["source"] = "USER",
): ContextItem {
  const item: ContextItem = {
    id: nid(),
    projectId,
    source,
    kind,
    content,
    status,
    createdAt: new Date().toISOString(),
  };
  persist({ ...memory, context: [...memory.context, item] });
  enqueue(() => persistAccountContext({ data: item }));
  return item;
}

export type CreateTaskInput = {
  projectId: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  selectedChatSourceIds?: string[];
  selectedFileIds?: string[];
  requiresHistoricalContext?: boolean;
  candidateArtifactId?: string | null;
  decisionQuestion?: string | null;
};

export function createTask(input: CreateTaskInput): Task {
  const requested =
    input.selectedChatSourceIds === undefined
      ? memoryChatIds(memory.chatSources, input.projectId)
      : input.selectedChatSourceIds;
  const selected = filterSelectedForProject(requested, memory.chatSources, input.projectId);
  const requestedFiles =
    input.selectedFileIds === undefined
      ? memory.projectFiles.filter((row) => row.projectId === input.projectId && row.includeInMemory).map((row) => row.id)
      : input.selectedFileIds;
  const allowedFiles = new Set(
    memory.projectFiles.filter((row) => row.projectId === input.projectId).map((row) => row.id),
  );
  const selectedFiles = requestedFiles.filter((id) => allowedFiles.has(id));
  const mode = normalizeTaskMode(input.mode);
  const task: Task = {
    id: nid(),
    projectId: input.projectId,
    title: input.title,
    prompt: input.prompt,
    status: "CREATED",
    error: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    totalInputTokens: null,
    totalOutputTokens: null,
    totalCostUsd: null,
    totalLatencyMs: null,
    diagnostics: null,
    selectedChatSourceIds: selected,
    selectedFileIds: selectedFiles,
    mode,
    requiresHistoricalContext: input.requiresHistoricalContext ?? mode === "CREATE",
    candidateArtifactId: input.candidateArtifactId ?? null,
    decisionQuestion: input.decisionQuestion ?? (mode === "DECIDE" ? input.prompt : null),
    contextManifestId: null,
    contextHash: null,
  };
  persist({ ...memory, tasks: [task, ...memory.tasks] });
  enqueue(() => persistAccountTask({ data: task }));
  return task;
}

export function rememberResponses(taskId: string, rows: AgentResponse[]) {
  if (!rows.length) return;
  persist({
    ...memory,
    responses: [
      ...memory.responses.filter((row) => row.taskId !== taskId || !rows.some((next) => next.id === row.id)),
      ...rows,
    ],
  });
  const task = memory.tasks.find((row) => row.id === taskId);
  if (task) {
    enqueue(() =>
      persistAccountCouncil({
        data: {
          task,
          responses: memory.responses.filter((row) => row.taskId === taskId),
          result: memory.results.find((row) => row.taskId === taskId) ?? null,
          artifact: memory.artifacts.find((row) => row.taskId === taskId) ?? null,
          manifest: memory.manifests.filter((row) => row.taskId === taskId).at(-1) ?? null,
          packet: memory.packets.find((row) => row.taskId === taskId) ?? null,
          artifacts: memory.artifacts,
        },
      }),
    );
  }
}

export function rememberManifest(taskId: string, manifest: ContextManifest) {
  persist({
    ...memory,
    manifests: [...memory.manifests.filter((row) => row.id !== manifest.id), manifest],
    tasks: memory.tasks.map((task) =>
      task.id === taskId
        ? { ...task, contextManifestId: manifest.id, contextHash: manifest.hash }
        : task,
    ),
  });
  const task = memory.tasks.find((row) => row.id === taskId);
  if (task) enqueue(() => persistAccountManifest({ data: { task, manifest } }));
}

export function patchTask(taskId: string, patch: Partial<Task>) {
  persist({
    ...memory,
    tasks: memory.tasks.map((t) => {
      if (t.id !== taskId) return t;
      const next = { ...t, ...patch };
      if (patch.selectedChatSourceIds) {
        next.selectedChatSourceIds = filterSelectedForProject(
          patch.selectedChatSourceIds,
          memory.chatSources,
          t.projectId,
        );
      }
      if (patch.selectedFileIds) {
        const allowed = new Set(
          memory.projectFiles.filter((row) => row.projectId === t.projectId).map((row) => row.id),
        );
        next.selectedFileIds = patch.selectedFileIds.filter((id) => allowed.has(id));
      }
      return next;
    }),
  });
  const task = memory.tasks.find((row) => row.id === taskId);
  if (task) enqueue(() => persistAccountTask({ data: task }));
}

export function applyCouncilOutput(
  taskId: string,
  patch: {
    task: Task;
    responses: AgentResponse[];
    result: CouncilResult | null;
    artifact?: Artifact | null;
    manifest?: ContextManifest | null;
    packet?: ImplementationPacket | null;
  },
) {
  const existing = memory.tasks.find((t) => t.id === taskId);
  const mergedTask = {
    ...patch.task,
    selectedChatSourceIds: existing?.selectedChatSourceIds ?? patch.task.selectedChatSourceIds,
    selectedFileIds: existing?.selectedFileIds ?? patch.task.selectedFileIds,
    mode: existing?.mode ?? patch.task.mode,
    requiresHistoricalContext: existing?.requiresHistoricalContext ?? patch.task.requiresHistoricalContext,
    candidateArtifactId: existing?.candidateArtifactId ?? patch.task.candidateArtifactId,
    decisionQuestion: existing?.decisionQuestion ?? patch.task.decisionQuestion,
  };
  let artifacts = memory.artifacts;
  if (patch.artifact) {
    artifacts = [...artifacts.filter((row) => row.id !== patch.artifact!.id), patch.artifact];
  } else if (mergedTask.mode === "REVIEW" && mergedTask.candidateArtifactId && patch.result) {
    const nextStatus = artifactStatusForReview(reviewVerdictFor(mergedTask.mode, patch.result), patch.result.status);
    artifacts = artifacts.map((row) =>
      row.id === mergedTask.candidateArtifactId ? { ...row, status: nextStatus } : row,
    );
  }
  const manifests = patch.manifest
    ? [...memory.manifests.filter((row) => row.id !== patch.manifest!.id), patch.manifest]
    : memory.manifests;
  let packets = memory.packets;
  if (patch.packet) {
    packets = [...packets.filter((row) => row.id !== patch.packet!.id), patch.packet];
  }
  let reviewedPacket: ImplementationPacket | null = patch.packet ?? null;
  if (mergedTask.mode === "REVIEW" && patch.result) {
    const verdict = reviewVerdictFor(mergedTask.mode, patch.result);
    if (verdict) {
      packets = packets.map((row) => {
        if (row.reviewTaskId !== taskId) return row;
        const next = applyPacketReview(row, verdict);
        reviewedPacket = next;
        return next;
      });
    }
  }
  persist({
    ...memory,
    tasks: memory.tasks.map((t) => (t.id === taskId ? mergedTask : t)),
    responses: [...memory.responses.filter((r) => r.taskId !== taskId), ...patch.responses],
    results: patch.result
      ? [...memory.results.filter((r) => r.taskId !== taskId), patch.result]
      : memory.results.filter((r) => r.taskId !== taskId),
    artifacts,
    manifests,
    packets,
  });
  const task = memory.tasks.find((row) => row.id === taskId) ?? mergedTask;
  enqueue(() =>
    persistAccountCouncil({
      data: {
        task,
        responses: patch.responses,
        result: patch.result,
        artifact: patch.artifact ?? null,
        manifest: patch.manifest ?? null,
        packet: reviewedPacket,
        artifacts,
      },
    }),
  );
}

export function rememberPacket(packet: ImplementationPacket) {
  persist({
    ...memory,
    packets: [...memory.packets.filter((row) => row.id !== packet.id), packet],
  });
  enqueue(() => persistAccountPacket({ data: packet }));
}

export function handOffImplementation(packetId: string): ImplementationPacket | null {
  const current = memory.packets.find((row) => row.id === packetId);
  if (!current) return null;
  const next = handOffPacket(current);
  rememberPacket(next);
  return next;
}

export function recordPacketImplementation(
  packetId: string,
  input: { status: ImplementationStatus; notes: string },
): ImplementationPacket | null {
  const current = memory.packets.find((row) => row.id === packetId);
  if (!current) return null;
  const next = recordImplementation(current, input);
  rememberPacket(next);
  return next;
}

export function openImplementationReview(packetId: string): Task | null {
  const current = memory.packets.find((row) => row.id === packetId);
  if (!current) return null;
  const artifact = memory.artifacts.find((row) => row.id === current.artifactId);
  const task = createTask({
    projectId: current.projectId,
    title: `Review implementation ${current.iteration}: ${artifact?.title ?? current.scope.slice(0, 80)}`,
    prompt: `Review the implementation result against this packet.\n\n${current.scope}\n\nNotes:\n${current.implementationNotes ?? "(none)"}\n\nStatus: ${current.implementationStatus ?? "unknown"}`,
    mode: "REVIEW",
    candidateArtifactId: current.artifactId,
    requiresHistoricalContext: false,
    selectedChatSourceIds: [],
    selectedFileIds: [],
  });
  rememberPacket(openPacketReview(current, task.id));
  return task;
}

export function markTaskFailed(taskId: string, error: string) {
  persist({
    ...memory,
    tasks: memory.tasks.map((t) =>
      t.id === taskId
        ? { ...t, status: "FAILED", error, completedAt: new Date().toISOString() }
        : t,
    ),
  });
  const task = memory.tasks.find((row) => row.id === taskId);
  if (task) enqueue(() => persistAccountTask({ data: task }));
}

export function addChatSource(source: ChatSource, messages: HistoryMessage[]): ChatSource {
  persist({
    ...memory,
    chatSources: [source, ...memory.chatSources],
    historyMessages: [...memory.historyMessages, ...messages],
  });
  enqueue(() => persistAccountChat({ data: { source, messages, replaceMessages: false } }));
  return source;
}

export function replaceChatSource(id: string, source: ChatSource, messages: HistoryMessage[]): ChatSource {
  const prev = memory.chatSources.find((row) => row.id === id);
  const nextSource = {
    ...source,
    id,
    createdAt: prev?.createdAt ?? source.createdAt,
    includeInMemory: Boolean(prev?.includeInMemory) && source.importStatus !== "ARCHIVED",
  };
  const nextMessages = messages.map((row) => ({ ...row, chatSourceId: id }));
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) => (row.id === id ? nextSource : row)),
    historyMessages: [
      ...memory.historyMessages.filter((row) => row.chatSourceId !== id),
      ...nextMessages,
    ],
  });
  enqueue(() => persistAccountChat({ data: { source: nextSource, messages: nextMessages, replaceMessages: true } }));
  return nextSource;
}

function persistPatchedChat(id: string) {
  const source = memory.chatSources.find((row) => row.id === id);
  if (source) enqueue(() => persistAccountChatPatch({ data: source }));
}

export function patchChatSource(id: string, patch: Partial<ChatSource>) {
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) =>
      row.id === id ? { ...row, ...patch, rawContent: row.rawContent, contentHash: row.contentHash } : row,
    ),
  });
  persistPatchedChat(id);
}

export function renameChatSource(id: string, title: string) {
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) => (row.id === id ? { ...row, title } : row)),
  });
  persistPatchedChat(id);
}

export function setChatIncludeInMemory(id: string, include: boolean) {
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) =>
      row.id === id
        ? { ...row, includeInMemory: include && row.importStatus !== "ARCHIVED" }
        : row,
    ),
  });
  persistPatchedChat(id);
}

export function setChatArchived(id: string, archived: boolean) {
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) => {
      if (row.id !== id) return row;
      if (archived) {
        return { ...row, importStatus: "ARCHIVED" as ImportStatus, includeInMemory: false };
      }
      if (row.importStatus !== "ARCHIVED") return row;
      return { ...row, importStatus: "IMPORTED" as ImportStatus };
    }),
  });
  persistPatchedChat(id);
}

export function archiveChatSource(id: string) {
  setChatArchived(id, true);
}

export function deleteChatSource(id: string) {
  persist({
    ...memory,
    chatSources: memory.chatSources.filter((row) => row.id !== id),
    historyMessages: memory.historyMessages.filter((row) => row.chatSourceId !== id),
    tasks: memory.tasks.map((task) => ({
      ...task,
      selectedChatSourceIds: task.selectedChatSourceIds.filter((sid) => sid !== id),
    })),
  });
  enqueue(() => persistAccountDeleteChat({ data: { chatId: id, tasks: memory.tasks } }));
}

export function recordAccessCheck(
  id: string,
  accessStatus: AccessStatus,
  lastError: string | null,
) {
  const now = new Date().toISOString();
  persist({
    ...memory,
    chatSources: memory.chatSources.map((row) =>
      row.id === id
        ? applyRemoteAccessChange(row, {
            accessStatus,
            lastAccessCheckAt: now,
            lastError,
          })
        : row,
    ),
  });
  persistPatchedChat(id);
}

export function addProjectFile(file: ProjectFile): ProjectFile {
  persist({ ...memory, projectFiles: [file, ...memory.projectFiles] });
  enqueue(() => persistAccountFile({ data: file }));
  return file;
}

export function setFileIncludeInMemory(id: string, include: boolean) {
  persist({
    ...memory,
    projectFiles: memory.projectFiles.map((row) => (row.id === id ? { ...row, includeInMemory: include } : row)),
  });
  const file = memory.projectFiles.find((row) => row.id === id);
  if (file) enqueue(() => persistAccountFile({ data: file }));
}

export function deleteProjectFile(id: string) {
  persist({
    ...memory,
    projectFiles: memory.projectFiles.filter((row) => row.id !== id),
    tasks: memory.tasks.map((task) => ({
      ...task,
      selectedFileIds: task.selectedFileIds.filter((sid) => sid !== id),
    })),
  });
  enqueue(() => persistAccountDeleteFile({ data: { fileId: id, tasks: memory.tasks } }));
}

