export type OperatorRecord = {
  summary: string;
  completed: string[];
  notCompleted: string[];
  implementation: string[];
  blockers: string[];
  recommended: string[];
  required: string[];
  userActions: string[];
  nextStep: string;
};

const EMPTY = new Set(["none", "n/a", "na", "-", "—", ""]);

function lines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const text = String(row ?? "").replace(/\s+/g, " ").trim();
    if (!text || EMPTY.has(text.toLowerCase())) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export const SAMPLE_OPERATOR_RECORD: OperatorRecord = {
  summary: "Council produced a candidate ready for review. No blocking P0 remains.",
  completed: ["Reconstructed the requested artifact from the Council debate."],
  notCompleted: ["REVIEW has not run yet."],
  implementation: ["Repository evidence is not attached; implementation status is unknown."],
  blockers: [],
  recommended: ["Run a REVIEW Council against the candidate artifact."],
  required: [],
  userActions: [],
  nextStep: "Run REVIEW on the reconstructed artifact.",
};

export function operatorRecordJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: SAMPLE_OPERATOR_RECORD.summary,
    completed: SAMPLE_OPERATOR_RECORD.completed,
    not_completed: SAMPLE_OPERATOR_RECORD.notCompleted,
    implementation: SAMPLE_OPERATOR_RECORD.implementation,
    blockers: SAMPLE_OPERATOR_RECORD.blockers,
    recommended: SAMPLE_OPERATOR_RECORD.recommended,
    required: SAMPLE_OPERATOR_RECORD.required,
    user_actions: SAMPLE_OPERATOR_RECORD.userActions,
    next_step: SAMPLE_OPERATOR_RECORD.nextStep,
    ...overrides,
  };
}

export function operatorRecordSchema() {
  const properties = {
    summary: { type: "string" },
    completed: { type: "array", items: { type: "string" } },
    not_completed: { type: "array", items: { type: "string" } },
    implementation: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
    recommended: { type: "array", items: { type: "string" } },
    required: { type: "array", items: { type: "string" } },
    user_actions: { type: "array", items: { type: "string" } },
    next_step: { type: "string" },
  };
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

export const OPERATOR_RECORD_EXAMPLE =
  '"operator_record":{"summary":"","completed":[],"not_completed":[],"implementation":[],"blockers":[],"recommended":[],"required":[],"user_actions":[],"next_step":""}';

export const OPERATOR_RECORD_PROMPT = `Also fill operator_record in the same JSON: a human-readable English Decision Record the operator can read without decoding other fields. Write as if explaining to a person who will not see issue ids, member_id, or protocol headings.
summary = 1-3 plain sentences (Outcome).
completed / not_completed = what the Council did and did not finish, short sentences.
implementation = current state of the code/repository (what exists, what is design-only, what is missing) — not a future backlog.
blockers = the stuck point in plain language, one sentence each. No issue ids. No REMAINING_P0. No member_id.
recommended / required / user_actions = short sentences the operator can act on.
next_step = the one next action in plain English.
English only. Empty lists are [].`;

export function parseOperatorRecord(value: unknown): OperatorRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const summary = String(rec.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) return null;
  return {
    summary,
    completed: lines(rec.completed),
    notCompleted: lines(rec.not_completed ?? rec.notCompleted),
    implementation: lines(rec.implementation),
    blockers: lines(rec.blockers),
    recommended: lines(rec.recommended ?? rec.recommendations),
    required: lines(rec.required),
    userActions: lines(rec.user_actions ?? rec.userActions),
    nextStep: String(rec.next_step ?? rec.nextStep ?? "").replace(/\s+/g, " ").trim(),
  };
}
