import type { Artifact, Task, TaskMode } from "./types.ts";

export const TASK_MODES: TaskMode[] = ["CREATE", "REVIEW", "DECIDE"];

export const MODE_COPY: Record<TaskMode, { label: string; hint: string }> = {
  CREATE: {
    label: "Create",
    hint: "Build a new canonical artifact from the task and selected evidence. No candidate artifact is required.",
  },
  REVIEW: {
    label: "Review",
    hint: "Review an existing candidate. Returns PASS, PATCH, or BLOCKED with issues and proposed corrections.",
  },
  DECIDE: {
    label: "Decide",
    hint: "Resolve a bounded decision: decision, alternatives, rationale, evidence, and risks.",
  },
};

export const ZERO_SOURCE_MESSAGE =
  "Historical reconstruction requires at least one selected imported chat or file.";

export const REVIEW_CANDIDATE_MESSAGE =
  "REVIEW mode requires a candidate artifact. Create one with a CREATE task first.";

export const DECIDE_QUESTION_MESSAGE = "DECIDE mode requires an explicit decision question.";

export function isTaskMode(value: string | null | undefined): value is TaskMode {
  return value === "CREATE" || value === "REVIEW" || value === "DECIDE";
}

export function defaultRequiresHistorical(mode: TaskMode): boolean {
  return mode === "CREATE";
}

export function normalizeTaskMode(value: unknown): TaskMode {
  return isTaskMode(String(value ?? "")) ? (value as TaskMode) : "REVIEW";
}

export type CouncilPreflight = {
  ok: boolean;
  code: "OK" | "PRECHECK_FAIL";
  error: string | null;
  providerCalls: 0;
};

export function councilPreflight(input: {
  task: Pick<
    Task,
    "mode" | "requiresHistoricalContext" | "selectedChatSourceIds" | "selectedFileIds" | "candidateArtifactId" | "decisionQuestion" | "prompt"
  >;
  artifacts: Artifact[];
}): CouncilPreflight {
  const mode = normalizeTaskMode(input.task.mode);
  if (mode === "REVIEW") {
    const candidateId = input.task.candidateArtifactId;
    const candidate = candidateId ? input.artifacts.find((row) => row.id === candidateId) : null;
    if (!candidate) {
      return { ok: false, code: "PRECHECK_FAIL", error: REVIEW_CANDIDATE_MESSAGE, providerCalls: 0 };
    }
  }
  if (mode === "DECIDE") {
    const question = (input.task.decisionQuestion || input.task.prompt || "").trim();
    if (!question) {
      return { ok: false, code: "PRECHECK_FAIL", error: DECIDE_QUESTION_MESSAGE, providerCalls: 0 };
    }
  }
  if (mode === "CREATE" && input.task.requiresHistoricalContext) {
    const sources =
      input.task.selectedChatSourceIds.length + (input.task.selectedFileIds ?? []).length;
    if (sources === 0) {
      return { ok: false, code: "PRECHECK_FAIL", error: ZERO_SOURCE_MESSAGE, providerCalls: 0 };
    }
  }
  return { ok: true, code: "OK", error: null, providerCalls: 0 };
}

const NON_BLOCKING_CREATE =
  /no (pre-existing |existing )?candidate|candidate artifact.{0,40}(missing|absent|not (supplied|provided|present))|there is no candidate|nonexistent candidate|no repository|repository (is )?(absent|missing|unavailable)|no git|no runtime evidence|implementation status.{0,60}unknown/i;

export function isNonBlockingCreateFinding(text: string): boolean {
  return NON_BLOCKING_CREATE.test(text);
}

export function filterCreateBlockers(items: string[]): string[] {
  return items.filter((item) => !isNonBlockingCreateFinding(item));
}

export function artifactStatusForCreate(status: Task["status"] | string, councilStatus: string | null): Artifact["status"] {
  if (councilStatus === "BLOCKED" || status === "FAILED") return "BLOCKED";
  if (councilStatus === "USER_DECISION_REQUIRED") return "DRAFT";
  return "READY_FOR_REVIEW";
}
