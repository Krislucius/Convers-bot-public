import type { DecisionRecord, NextAction } from "./decision.ts";
import type { CouncilResult, TaskMode } from "./types.ts";

export type FollowOnSource = {
  id: string;
  title: string;
  prompt: string;
  canonicalTaskEn?: string | null;
  mode: TaskMode;
  candidateArtifactId: string | null;
  decisionQuestion: string | null;
};

export type SpawnFollowOn = {
  kind: "SPAWN_TASK";
  mode: TaskMode;
  title: string;
  prompt: string;
  candidateArtifactId: string | null;
  decisionQuestion: string | null;
};

export type NavigateFollowOn = {
  kind: "NAVIGATE";
  to: "chats" | "files";
};

export type AcceptFollowOn = { kind: "ACCEPT" };
export type NoneFollowOn = { kind: "NONE" };

export type FollowOnPlan = SpawnFollowOn | NavigateFollowOn | AcceptFollowOn | NoneFollowOn;

const CONTRACT =
  "Presenting unfrozen architecture as frozen is a contract violation. Memory freeze happens only after a later ACCEPT.";

function clip(text: string, max: number): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function clipTitle(prefix: string, title: string): string {
  const base = `${prefix}: ${title.replace(/\s+/g, " ").trim() || "previous task"}`;
  return base.length <= 80 ? base : `${base.slice(0, 77).trimEnd()}…`;
}

function listBlock(title: string, rows: string[]): string {
  const items = rows.map((row) => clip(row, 240)).filter(Boolean).slice(0, 8);
  if (!items.length) return `${title}: none`;
  return `${title}:\n${items.map((row) => `- ${row}`).join("\n")}`;
}

export function briefDecisionRecord(record: DecisionRecord): string {
  const blockers = record.blockerNotes.length ? record.blockerNotes : record.blockers.map((row) => row.title);
  const user = record.userActions.length ? record.userActions : record.userDecisions;
  return [
    `Verdict: ${record.verdict ?? "none"}`,
    `Summary: ${clip(record.summary || record.conclusion, 400)}`,
    listBlock("What was done", record.completed.length ? record.completed : record.agreed),
    listBlock("What was not done", record.notCompleted),
    listBlock("Blockers", blockers),
    listBlock("Recommended", record.recommendations),
    listBlock("Required", record.required),
    listBlock("User actions", user),
    `Next step: ${clip(record.nextActionWhy, 400) || "none"}`,
  ].join("\n\n");
}

function previousTaskBody(source: FollowOnSource): string {
  return clip(source.canonicalTaskEn || source.prompt, 2000);
}

export function createPatchPrompt(record: DecisionRecord, source: FollowOnSource): string {
  return `OPERATOR COMMAND
The operator clicked CREATE PATCH so Council will follow its own next step from the previous Decision Record. Do not repeat the same Council unchanged.

Your recorded next step was:
${clip(record.nextActionWhy, 500) || "Create the patch required to unblock acceptance."}

Execute that next step as a CREATE patch.
If the next step is to freeze architecture or invariants, write the freeze as a cited candidate artifact. Do not claim they are already FROZEN. ${CONTRACT}
Keep every freeze claim cited from the selected chats or files. Do not invent frozen invariants without citations.

Previous task: ${clip(source.title, 120)} (${source.mode})
Previous canonical task:
${previousTaskBody(source)}

Previous Decision Record (English, canonical):
${briefDecisionRecord(record)}`;
}

export function reviewFollowOnPrompt(record: DecisionRecord, source: FollowOnSource): string {
  return `OPERATOR COMMAND
The operator clicked RUN REVIEW so Council will follow its own next step.

Review the candidate artifact against the previous Decision Record. Do not freeze Memory.

Your recorded next step was:
${clip(record.nextActionWhy, 500) || "Run REVIEW on the reconstructed artifact."}

Previous task: ${clip(source.title, 120)} (${source.mode})
Previous Decision Record (English, canonical):
${briefDecisionRecord(record)}`;
}

export function decideFollowOnPrompt(record: DecisionRecord, source: FollowOnSource, question: string): string {
  return `OPERATOR COMMAND
The operator clicked RUN DECIDE so Council will follow its own next step.

Decision question:
${clip(question, 500)}

Your recorded next step was:
${clip(record.nextActionWhy, 500) || "Resolve the remaining operator choice."}

Previous task: ${clip(source.title, 120)} (${source.mode})
Previous Decision Record (English, canonical):
${briefDecisionRecord(record)}`;
}

export function freezeTexts(
  record: Pick<DecisionRecord, "agreed" | "completed" | "summary" | "conclusion">,
  result?: Pick<CouncilResult, "consensus" | "decision"> | null,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const rows = [
    ...(result?.consensus ?? []),
    ...(record.agreed ?? []),
    ...(record.completed ?? []),
  ];
  if (result?.decision) rows.push(result.decision);
  if (!rows.length && (record.summary || record.conclusion)) {
    rows.push(record.summary || record.conclusion);
  }
  for (const row of rows) {
    const text = String(row ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, 12);
}

function decideQuestion(record: DecisionRecord, source: FollowOnSource): string {
  const fromSource = String(source.decisionQuestion ?? "").trim();
  if (fromSource) return fromSource;
  const fromUser = (record.userActions[0] || record.userDecisions[0] || "").trim();
  if (fromUser) return fromUser;
  const fromWhy = record.nextActionWhy.trim();
  if (fromWhy) return fromWhy;
  return "Resolve the remaining operator choice from the previous Decision Record.";
}

export function isCommandNextAction(
  action: NextAction | null,
): action is Exclude<NextAction, "NO_ACTION"> {
  return Boolean(action) && action !== "NO_ACTION";
}

export function followOnPlan(input: {
  nextAction: NextAction | null;
  record: DecisionRecord;
  source: FollowOnSource;
  artifactId?: string | null;
}): FollowOnPlan {
  const action = input.nextAction;
  if (!isCommandNextAction(action)) return { kind: "NONE" };
  const candidate = input.artifactId ?? input.source.candidateArtifactId ?? null;

  if (action === "CREATE_PATCH") {
    return {
      kind: "SPAWN_TASK",
      mode: "CREATE",
      title: clipTitle("Patch", input.source.title),
      prompt: createPatchPrompt(input.record, input.source),
      candidateArtifactId: candidate,
      decisionQuestion: null,
    };
  }

  if (action === "RUN_REVIEW") {
    return {
      kind: "SPAWN_TASK",
      mode: "REVIEW",
      title: clipTitle("REVIEW", input.source.title),
      prompt: reviewFollowOnPrompt(input.record, input.source),
      candidateArtifactId: candidate,
      decisionQuestion: null,
    };
  }

  if (action === "RUN_DECIDE") {
    const question = decideQuestion(input.record, input.source);
    return {
      kind: "SPAWN_TASK",
      mode: "DECIDE",
      title: clipTitle("DECIDE", input.source.title),
      prompt: decideFollowOnPrompt(input.record, input.source, question),
      candidateArtifactId: candidate,
      decisionQuestion: question,
    };
  }

  if (action === "ADD_EVIDENCE") return { kind: "NAVIGATE", to: "chats" };
  if (action === "ADD_REPOSITORY_EVIDENCE") return { kind: "NAVIGATE", to: "files" };
  if (action === "ACCEPT") return { kind: "ACCEPT" };
  return { kind: "NONE" };
}
