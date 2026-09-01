import type { ContextItem, Project, Task } from "../council/types.ts";
import { CURRENT_CONTEXT_CHAR_LIMIT } from "../architecture/contracts.ts";
import type { LedgerEntry, PackOmission, PackResult } from "./types.ts";
import { PACKER_VERSION } from "./types.ts";

export { PACKER_VERSION };

const SOURCE_CAP_RATIO = 0.4;

function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/i)
    .filter((row) => row.length > 2);
}

export function scoreEvidence(entry: LedgerEntry, task: Task): number {
  const query = new Set(tokensOf(`${task.title} ${task.prompt} ${task.decisionQuestion ?? ""}`));
  if (query.size === 0) return 0;
  const claim = tokensOf(entry.claim);
  let hits = 0;
  for (const token of claim) if (query.has(token)) hits += 1;
  return hits;
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

export function packEvidence(input: {
  project: Pick<Project, "name" | "description">;
  task: Task;
  frozen: ContextItem[];
  entries: LedgerEntry[];
  candidateText?: string | null;
  budgetChars?: number;
}): PackResult {
  const budget = input.budgetChars ?? CURRENT_CONTEXT_CHAR_LIMIT;
  const mandatory = buildMandatoryContext(input.project, input.task, input.frozen, {
    candidateText: input.candidateText,
  });
  if (mandatory.length > budget) {
    return {
      ok: false,
      code: "CONTEXT_BUDGET_EXCEEDED",
      text: "",
      packed: [],
      omitted: [],
      mandatoryChars: mandatory.length,
      evidenceChars: 0,
    };
  }

  const ranked = [...input.entries].sort((a, b) => {
    const score = scoreEvidence(b, input.task) - scoreEvidence(a, input.task);
    if (score !== 0) return score;
    if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
    return a.citation < b.citation ? -1 : 1;
  });

  const remaining = budget - mandatory.length;
  const cap = Math.max(0, Math.floor(remaining * SOURCE_CAP_RATIO));
  const packed: LedgerEntry[] = [];
  const omitted: PackOmission[] = [];
  const seenClaim = new Set<string>();
  const perSource = new Map<string, number>();
  let used = 0;
  const header = "\n## EVIDENCE LEDGER (non-canonical historical evidence)\n";
  used += header.length;

  for (const entry of ranked) {
    const claimKey = entry.claim.trim().toLowerCase();
    if (seenClaim.has(claimKey)) {
      omitted.push({ citation: entry.citation, claim: entry.claim, sourceId: entry.sourceId, reason: "DUPLICATE" });
      continue;
    }
    const line = `- [${entry.status}] ${entry.claim} ${entry.citation}\n`;
    const sourceUsed = perSource.get(entry.sourceId) ?? 0;
    if (sourceUsed + line.length > cap && packed.some((row) => row.sourceId === entry.sourceId)) {
      omitted.push({ citation: entry.citation, claim: entry.claim, sourceId: entry.sourceId, reason: "SOURCE_CAP" });
      continue;
    }
    if (used + line.length > remaining) {
      omitted.push({ citation: entry.citation, claim: entry.claim, sourceId: entry.sourceId, reason: "BUDGET" });
      continue;
    }
    packed.push(entry);
    seenClaim.add(claimKey);
    perSource.set(entry.sourceId, sourceUsed + line.length);
    used += line.length;
  }

  const evidenceBlock = packed.length
    ? `${header}${packed.map((row) => `- [${row.status}] ${row.claim} ${row.citation}`).join("\n")}`
    : `${header}(none)`;
  const text = `${mandatory}${evidenceBlock}`;
  return {
    ok: true,
    code: "OK",
    text,
    packed,
    omitted,
    mandatoryChars: mandatory.length,
    evidenceChars: evidenceBlock.length,
  };
}
