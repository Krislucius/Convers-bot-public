import type { ContextItem, Project, Task } from "../council/types.ts";
import { CURRENT_CONTEXT_TOKEN_LIMIT } from "../architecture/contracts.ts";
import { countTokens } from "./tokens.ts";
import { truncateClaim } from "./preview.ts";
import type { LedgerEntry, PackOmission, PackResult } from "./types.ts";
import { PACKER_VERSION } from "./types.ts";

export { PACKER_VERSION };

export const SOURCE_CAP_RATIO = 0.4;
export const OMITTED_CLAIM_CHARS = 96;
export const LEDGER_HEADER = "\n## EVIDENCE LEDGER (non-canonical historical evidence)\n";

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/i)
    .filter((row) => row.length > 2);
}

function scoreAgainst(entry: LedgerEntry, query: Set<string>): number {
  if (query.size === 0) return 0;
  const claim = tokensOf(entry.claim);
  let hits = 0;
  for (const token of claim) if (query.has(token)) hits += 1;
  return hits;
}

export function scoreEvidence(entry: LedgerEntry, task: Task): number {
  const query = new Set(tokensOf(`${task.title} ${task.prompt} ${task.decisionQuestion ?? ""}`));
  return scoreAgainst(entry, query);
}

export function buildMandatoryContext(
  project: { name: string; description: string },
  task: Task,
  items: ContextItem[],
  extras?: { candidateText?: string | null },
): string {
  const mode = task.mode;
  const chunks: string[] = [
    `PROJECT: ${project.name}`,
    project.description,
    `TASK: ${task.title}`,
    `TASK MODE: ${mode}`,
    task.prompt,
  ];
  if (task.decisionQuestion) chunks.push(`DECISION QUESTION: ${task.decisionQuestion}`);
  chunks.push(`SELECTED CHAT SOURCE IDS: ${task.selectedChatSourceIds.join(",") || "(none)"}`);
  chunks.push(`SELECTED FILE IDS: ${(task.selectedFileIds ?? []).join(",") || "(none)"}`);
  chunks.push(`REQUIRES HISTORICAL CONTEXT: ${task.requiresHistoricalContext ? "true" : "false"}`);
  if (mode === "REVIEW" && extras?.candidateText) {
    chunks.push(`\n## CANDIDATE ARTIFACT\n${extras.candidateText}`);
  }
  if (mode === "CREATE") {
    chunks.push(
      "CREATE MODE RULES: produce the artifact. Do not treat a missing candidate document as a blocker. Repository absence => implementation status UNKNOWN, not BLOCKED.",
    );
  }
  const order = ["INVARIANT", "SPECIFICATION", "DECISION", "PROJECT_STATE"] as const;
  for (const kind of order) {
    const rows = items.filter((item) => item.kind === kind && item.projectId === task.projectId);
    if (!rows.length) continue;
    chunks.push(`\n## ${kind}`);
    for (const row of rows) chunks.push(`- [${row.status}] ${row.content}`);
  }
  return chunks.join("\n");
}

export function claimLine(entry: LedgerEntry): string {
  return `- [${entry.status}] ${entry.claim} ${entry.citation}`;
}

export function assemblePackedContext(mandatory: string, packed: LedgerEntry[]): string {
  if (!packed.length) return `${mandatory}${LEDGER_HEADER}(none)`;
  return `${mandatory}${LEDGER_HEADER}${packed.map(claimLine).join("\n")}`;
}

function compactOmission(entry: LedgerEntry, reason: PackOmission["reason"]): PackOmission {
  return {
    citation: entry.citation,
    claim: truncateClaim(entry.claim, OMITTED_CLAIM_CHARS),
    sourceId: entry.sourceId,
    reason,
  };
}

function rankEntries(entries: LedgerEntry[], task: Task): LedgerEntry[] {
  const query = new Set(tokensOf(`${task.title} ${task.prompt} ${task.decisionQuestion ?? ""}`));
  return [...entries]
    .map((entry) => ({
      entry,
      score: scoreAgainst(entry, query),
    }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.entry.sourceId !== b.entry.sourceId) return a.entry.sourceId < b.entry.sourceId ? -1 : 1;
      return a.entry.citation < b.entry.citation ? -1 : 1;
    })
    .map((row) => row.entry);
}

export function packEvidence(input: {
  project: Pick<Project, "name" | "description">;
  task: Task;
  frozen: ContextItem[];
  entries: LedgerEntry[];
  candidateText?: string | null;
  budgetTokens?: number;
  selectedSourceCount?: number;
}): PackResult {
  const budget = input.budgetTokens ?? CURRENT_CONTEXT_TOKEN_LIMIT;
  const mandatory = buildMandatoryContext(input.project, input.task, input.frozen, {
    candidateText: input.candidateText,
  });
  const mandatoryTokens = countTokens(mandatory);
  if (mandatoryTokens > budget) {
    return {
      ok: false,
      code: "CONTEXT_BUDGET_EXCEEDED",
      text: "",
      packed: [],
      omitted: [],
      mandatoryTokens,
      evidenceTokens: 0,
      totalTokens: 0,
    };
  }

  const selectedSourceCount =
    input.selectedSourceCount ?? new Set(input.entries.map((row) => row.sourceId)).size;
  const applyCap = selectedSourceCount > 1;
  const remainingBudget = budget - mandatoryTokens;
  const cap = applyCap ? Math.max(0, Math.floor(remainingBudget * SOURCE_CAP_RATIO)) : remainingBudget;

  const ranked = rankEntries(input.entries, input.task);
  const packed: LedgerEntry[] = [];
  const omitted: PackOmission[] = [];
  const held: LedgerEntry[] = [];
  const seenClaim = new Set<string>();
  const perSource = new Map<string, number>();
  const lineTokenCache = new Map<string, number>();
  const packedBaseTokens = countTokens(`${mandatory}${LEDGER_HEADER}`);
  let used = packedBaseTokens;

  const tokensFor = (entry: LedgerEntry): number => {
    const cached = lineTokenCache.get(entry.id);
    if (cached != null) return cached;
    const n = countTokens(claimLine(entry));
    lineTokenCache.set(entry.id, n);
    return n;
  };

  for (const entry of ranked) {
    const claimKey = entry.claim.trim().toLowerCase();
    if (seenClaim.has(claimKey)) {
      omitted.push(compactOmission(entry, "DUPLICATE"));
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      omitted.push(compactOmission(entry, "BUDGET"));
      continue;
    }
    const lineTokens = tokensFor(entry);
    if (lineTokens > remaining) {
      omitted.push(compactOmission(entry, "BUDGET"));
      continue;
    }
    const sourceUsed = perSource.get(entry.sourceId) ?? 0;
    if (applyCap && sourceUsed + lineTokens > cap && packed.some((row) => row.sourceId === entry.sourceId)) {
      held.push(entry);
      omitted.push(compactOmission(entry, "SOURCE_CAP"));
      continue;
    }
    packed.push(entry);
    seenClaim.add(claimKey);
    perSource.set(entry.sourceId, sourceUsed + lineTokens);
    used += lineTokens;
  }

  if (applyCap) {
    const stillHeld: PackOmission[] = [];
    for (const entry of held) {
      const lineTokens = tokensFor(entry);
      if (lineTokens > budget - used) {
        stillHeld.push(compactOmission(entry, "SOURCE_CAP"));
        continue;
      }
      packed.push(entry);
      used += lineTokens;
    }
    const kept = omitted.filter((row) => row.reason !== "SOURCE_CAP");
    omitted.length = 0;
    omitted.push(...kept, ...stillHeld);
  }

  const rankIndex = new Map(ranked.map((row, index) => [row.id, index]));
  packed.sort((a, b) => (rankIndex.get(a.id) ?? 0) - (rankIndex.get(b.id) ?? 0));

  const text = assemblePackedContext(mandatory, packed);
  const totalTokens = countTokens(text);
  if (totalTokens > budget) {
    return {
      ok: false,
      code: "CONTEXT_BUDGET_EXCEEDED",
      text: "",
      packed: [],
      omitted: [],
      mandatoryTokens,
      evidenceTokens: 0,
      totalTokens,
    };
  }
  return {
    ok: true,
    code: "OK",
    text,
    packed,
    omitted,
    mandatoryTokens,
    evidenceTokens: Math.max(0, totalTokens - mandatoryTokens),
    totalTokens,
  };
}
