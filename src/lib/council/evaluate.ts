import type {
  Artifact,
  CouncilResult,
  ImplementationPacket,
  ProjectQualitySummary,
  ReviewVerdict,
  Task,
  TaskQualityRow,
} from "./types.ts";
import { reviewVerdictFor } from "./review.ts";

function runStatusOf(task: Task): string {
  if (task.status === "COMPLETE" || task.status === "FAILED" || task.status === "CANCELLED") return task.status;
  if (
    task.status === "PREPARING" ||
    task.status === "COUNCIL_ROUND_1" ||
    task.status === "COUNCIL_ROUND_2" ||
    task.status === "SYNTHESIS"
  ) {
    return "RUNNING";
  }
  return task.status;
}

export function evaluateTask(input: {
  task: Task;
  result: CouncilResult | null;
  packets: ImplementationPacket[];
  artifacts: Artifact[];
}): TaskQualityRow {
  const packets = input.packets.filter((row) => row.taskId === input.task.id || row.reviewTaskId === input.task.id);
  const latest = packets.at(-1) ?? null;
  const related = input.packets.filter((row) => row.artifactId && row.artifactId === latest?.artifactId);
  const runStatus = runStatusOf(input.task);
  const verdict = reviewVerdictFor(input.task.mode, input.result);
  const rawVerdict = input.result?.reconciledStatus ?? input.result?.finalEnforcedStatus ?? input.result?.status ?? null;
  const taskVerdict = runStatus === "FAILED" || runStatus === "CANCELLED" ? null : rawVerdict;
  const laterCorrection =
    related.some((row) => row.iteration > 1) ||
    (input.task.mode === "REVIEW" &&
      verdict != null &&
      verdict !== "PASS" &&
      related.some((row) => row.status === "CLOSED"));
  return {
    taskId: input.task.id,
    mode: input.task.mode,
    runStatus,
    taskVerdict,
    councilOutcome: taskVerdict ?? runStatus,
    reviewVerdict: verdict,
    disagreements: input.result?.disagreements.length ?? 0,
    evidenceUsed: input.result?.citations.length ?? latest?.evidenceRefs.length ?? 0,
    iteration: latest?.iteration ?? 1,
    packetStatus: latest?.status ?? null,
    laterCorrection,
  };
}

export function evaluateProject(input: {
  projectId: string;
  tasks: Task[];
  results: CouncilResult[];
  packets: ImplementationPacket[];
  artifacts: Artifact[];
}): ProjectQualitySummary {
  const tasks = input.tasks.filter((row) => row.projectId === input.projectId);
  const resultsByTask = new Map(input.results.map((row) => [row.taskId, row]));
  const rows = tasks.map((task) =>
    evaluateTask({
      task,
      result: resultsByTask.get(task.id) ?? null,
      packets: input.packets.filter((row) => row.projectId === input.projectId),
      artifacts: input.artifacts.filter((row) => row.projectId === input.projectId),
    }),
  );
  const pass = rows.filter((row) => row.taskVerdict === "APPROVED").length;
  const patch = rows.filter((row) => row.taskVerdict === "PATCH").length;
  const blocked = rows.filter((row) => row.taskVerdict === "BLOCKED").length;
  const userDecision = rows.filter((row) => row.taskVerdict === "USER_DECISION_REQUIRED").length;
  const executionFailed = rows.filter(
    (row) => !row.taskVerdict && (row.runStatus === "FAILED" || row.runStatus === "CANCELLED"),
  ).length;
  return {
    projectId: input.projectId,
    taskCount: rows.length,
    executionFailed,
    approvedOrPass: pass,
    patch,
    blocked,
    userDecision,
    disagreements: rows.reduce((sum, row) => sum + row.disagreements, 0),
    evidenceUsed: rows.reduce((sum, row) => sum + row.evidenceUsed, 0),
    iterations: rows.reduce((sum, row) => sum + row.iteration, 0),
    laterCorrections: rows.filter((row) => row.laterCorrection).length,
    rows,
  };
}

export function displayVerdict(verdict: ReviewVerdict | null, status: string): string {
  if (verdict === "PASS" || (!verdict && status === "APPROVED")) return "APPROVED";
  if (verdict === "PATCH" || status === "PATCH") return "PATCH";
  if (verdict === "BLOCKED" || status === "BLOCKED") return "BLOCKED";
  if (status === "USER_DECISION_REQUIRED") return "USER_DECISION_REQUIRED";
  if (verdict) return verdict;
  return status.replaceAll("_", " ");
}

export function qualityLabel(row: TaskQualityRow): string {
  if (row.taskVerdict) return displayVerdict(row.reviewVerdict, row.taskVerdict);
  if (row.runStatus === "FAILED" || row.runStatus === "CANCELLED") return row.runStatus;
  return row.runStatus.replaceAll("_", " ");
}
