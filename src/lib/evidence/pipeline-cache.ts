import { hashContent } from "../history/hash.ts";
import { runEvidencePipeline } from "./pipeline.ts";

export type EvidencePipelineInput = Parameters<typeof runEvidencePipeline>[0];
export type EvidencePipelineResult = ReturnType<typeof runEvidencePipeline>;

const MAX_CACHE = 4;
const cache = new Map<string, EvidencePipelineResult>();

export function evidencePipelineKey(input: EvidencePipelineInput): string {
  const selectedChats = [...input.task.selectedChatSourceIds].sort();
  const selectedFiles = [...(input.task.selectedFileIds ?? [])].sort();
  const chatById = new Map(input.chatSources.map((row) => [row.id, row]));
  const fileById = new Map(input.projectFiles.map((row) => [row.id, row]));
  const chats = selectedChats.map((id) => {
    const row = chatById.get(id);
    return row ? `${id}:${row.contentHash}` : id;
  });
  const files = selectedFiles.map((id) => {
    const row = fileById.get(id);
    return row ? `${id}:${hashContent(row.extractedText)}` : id;
  });
  const frozen = input.frozen
    .filter((row) => row.projectId === input.task.projectId)
    .map((row) => `${row.id}:${row.kind}:${row.status}:${row.content}`)
    .sort();
  const messages = input.historyMessages
    .filter((row) => selectedChats.includes(row.chatSourceId))
    .map((row) => `${row.chatSourceId}:${row.sequence}:${row.content.length}:${row.content.slice(0, 48)}`);
  return hashContent(
    [
      input.project.id,
      input.project.name,
      input.project.description,
      input.task.id,
      input.task.title,
      input.task.prompt,
      input.task.mode,
      String(input.task.requiresHistoricalContext),
      input.task.candidateArtifactId ?? "",
      input.task.decisionQuestion ?? "",
      chats.join("|"),
      files.join("|"),
      frozen.join("|"),
      messages.join("|"),
      input.candidateText ?? "",
      (input.failSourceIds ?? []).join(","),
    ].join("\n"),
  );
}

export function cachedEvidencePipeline(input: EvidencePipelineInput): EvidencePipelineResult {
  const key = evidencePipelineKey(input);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = runEvidencePipeline(input);
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, result);
  return result;
}

export function peekEvidencePipeline(key: string): EvidencePipelineResult | undefined {
  return cache.get(key);
}

export function clearEvidencePipelineCache(): void {
  cache.clear();
}
