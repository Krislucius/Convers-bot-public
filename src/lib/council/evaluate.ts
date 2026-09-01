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

export function evaluateTask(input: {
  task: Task;
  result: CouncilResult | null;
  packets: ImplementationPacket[];
  artifacts: Artifact[];
}): TaskQualityRow {
  const packets = input.packets.filter((row) => row.taskId === input.task.id || row.reviewTaskId === input.task.id);
  const latest = packets.at(-1) ?? null;
  const related = input.packets.filter((row) => row.artifactId && row.artifactId === latest?.artifactId);
  const verdict = reviewVerdictFor(input.task.mode, input.result);
  const laterCorrection =
    related.some((row) => row.iteration > 1) ||
    (input.task.mode === "REVIEW" &&
      verdict != null &&
      verdict !== "PASS" &&
      related.some((row) => row.status === "CLOSED"));
  return {
    taskId: input.task.id,
    mode: input.task.mode,
    councilOutcome: input.result?.finalEnforcedStatus ?? input.result?.status ?? input.task.status,
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
  const pass = rows.filter((row) => row.reviewVerdict === "PASS" || row.councilOutcome === "APPROVED").length;
  const patch = rows.filter((row) => row.reviewVerdict === "PATCH" || row.councilOutcome === "PATCH").length;
  const blocked = rows.filter((row) => row.reviewVerdict === "BLOCKED" || row.councilOutcome === "BLOCKED").length;
  return {
    projectId: input.projectId,
    taskCount: rows.length,
    approvedOrPass: pass,
    patch,
    blocked,
    disagreements: rows.reduce((sum, row) => sum + row.disagreements, 0),
    evidenceUsed: rows.reduce((sum, row) => sum + row.evidenceUsed, 0),
    iterations: rows.reduce((sum, row) => sum + row.iteration, 0),
    laterCorrections: rows.filter((row) => row.laterCorrection).length,
    rows,
  };
}

export function displayVerdict(verdict: ReviewVerdict | null, status: string): string {
  if (verdict) return verdict;
  if (status === "APPROVED") return "PASS";
  if (status === "PATCH") return "PATCH";
  if (status === "BLOCKED") return "BLOCKED";
  return status.replaceAll("_", " ");
}
