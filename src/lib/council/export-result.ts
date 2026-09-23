import type { DecisionRecord } from "./decision.ts";
import type { AgentResponse, Artifact, CouncilResult, ProviderId, Task } from "./types.ts";
import type { CouncilMember } from "./members.ts";
import type { UiLanguage } from "../i18n/locale.ts";
import { actionLabel, statusLabel, t } from "../i18n/catalog.ts";

export type ExportPosition = {
  memberId: string;
  label: string;
  round1: string;
  round2: string;
};

export type ResultExportInput = {
  locale: UiLanguage;
  task: Pick<Task, "title" | "originalTitle" | "originalTask" | "prompt" | "canonicalTaskEn" | "mode">;
  provider: ProviderId | string;
  members: CouncilMember[];
  record: DecisionRecord;
  result: CouncilResult | null;
  responses: AgentResponse[];
  artifact: Artifact | null;
  narrative?: {
    decision?: string | null;
    rationale?: string | null;
    recommendation?: string | null;
    disagreements?: string[];
    issues?: string[];
    proposedCorrections?: string[];
    resolvedIssues?: string[];
    unresolvedIssues?: string[];
    synthesis?: string | null;
    round1?: Record<string, string>;
    round2?: Record<string, string>;
    positions?: Record<string, string>;
  } | null;
  localizedRecord?: {
    summary?: string;
    why?: string;
    completed?: string[];
    notCompleted?: string[];
    blockerNotes?: string[];
    recommendations?: string[];
    required?: string[];
    userActions?: string[];
    nextActionWhy?: string;
  } | null;
  sourceManifest?: string[];
};

function lines(title: string, rows: string[]): string {
  if (!rows.length) return `## ${title}\n\n- none\n`;
  return `## ${title}\n\n${rows.map((row) => `- ${row}`).join("\n")}\n`;
}

function shown(locale: UiLanguage, original: string, localized?: string | null): string {
  if (locale === "ru" && localized && localized.trim() && localized.trim() !== original.trim()) return localized;
  return original;
}

export function renderResultMarkdown(input: ResultExportInput): string {
  const locale = input.locale;
  const record = input.record;
  const loc = input.localizedRecord;
  const narrative = input.narrative;
  const title = input.task.originalTitle || input.task.title;
  const taskBody = input.task.originalTask || input.task.canonicalTaskEn || input.task.prompt;
  const verdict = record.verdict ? statusLabel(record.verdict, locale) : t("status.none", locale);
  const run = record.runStatus ? statusLabel(record.runStatus, locale) : t("status.none", locale);
  const positions = input.members.map((member) => {
    const round1 = input.responses.find(
      (row) => row.memberId === member.memberId && (row.stage === "ROUND_1" || row.round === 1) && row.round !== 3,
    );
    const round2 = input.responses.find(
      (row) => row.memberId === member.memberId && (row.stage === "ROUND_2" || row.round === 2),
    );
    return {
      label: `${member.role} · ${member.label}`,
      round1: shown(locale, round1?.responseText || "", narrative?.round1?.[member.memberId]),
      round2: shown(locale, round2?.responseText || "", narrative?.round2?.[member.memberId]),
    };
  });
  const synthesis = input.responses.find((row) => row.stage === "SYNTHESIS" || row.round === 3);
  const synthesisText = shown(locale, synthesis?.responseText || input.result?.synthesisRaw || "", narrative?.synthesis);
  const blockers = loc?.blockerNotes?.length
    ? loc.blockerNotes
    : record.blockerNotes.length
      ? record.blockerNotes
      : record.blockers.map((row) => row.title);
  const body = [
    `# ${t("record.title", locale)}`,
    ``,
    `## ${t("task.title", locale)}`,
    ``,
    title,
    ``,
    taskBody,
    ``,
    `## ${t("task.run", locale)}`,
    ``,
    `- ${t("task.mode", locale)}: ${input.task.mode}`,
    `- ${t("task.run", locale)}: ${run}`,
    `- ${t("task.verdict", locale)}: ${verdict}`,
    `- ${t("run.provider", locale)}: ${input.provider}`,
    ...input.members.map((member) => `- ${member.role} → ${member.label} (${member.modelId})`),
    ``,
    lines(t("fold.repository", locale), input.sourceManifest ?? []),
    `## ${t("record.outcome", locale)}`,
    ``,
    shown(locale, record.summary || record.conclusion, loc?.summary),
    ``,
    shown(locale, record.why, loc?.why),
    ``,
    lines(t("record.completed", locale), loc?.completed?.length ? loc.completed : record.completed),
    lines(t("record.notCompleted", locale), loc?.notCompleted?.length ? loc.notCompleted : record.notCompleted),
    lines(t("record.blockers", locale), blockers),
    lines(t("record.recommendations", locale), loc?.recommendations?.length ? loc.recommendations : record.recommendations),
    lines(t("record.required", locale), loc?.required?.length ? loc.required : record.required),
    lines(
      t("record.userActions", locale),
      loc?.userActions?.length ? loc.userActions : record.userActions.length ? record.userActions : record.userDecisions,
    ),
    `## ${t("record.next", locale)}`,
    ``,
    record.nextAction ? actionLabel(record.nextAction, locale) : t("action.NO_ACTION", locale),
    ``,
    shown(locale, record.nextActionWhy, loc?.nextActionWhy),
    ``,
    `## ${t("result.round1", locale)}`,
    ``,
    ...positions.flatMap((row) => [`### ${row.label}`, ``, row.round1 || t("task.noneRecorded", locale), ``]),
    `## ${t("result.round2", locale)}`,
    ``,
    ...positions.flatMap((row) => [`### ${row.label}`, ``, row.round2 || t("task.noneRecorded", locale), ``]),
    `## ${t("result.synthesis", locale)}`,
    ``,
    synthesisText || t("task.noneRecorded", locale),
    ``,
    lines(t("fold.disagreements", locale), narrative?.disagreements ?? input.result?.disagreements ?? []),
    lines(t("fold.resolvedIssues", locale), narrative?.resolvedIssues ?? input.result?.resolvedIssues ?? []),
    lines(t("fold.openFollowups", locale), narrative?.unresolvedIssues ?? input.result?.unresolvedIssues ?? []),
    lines(t("fold.citations", locale), input.result?.citations ?? []),
    `## ${t("task.candidate", locale)}`,
    ``,
    input.artifact
      ? `# ${input.artifact.title} v${input.artifact.version}\n\n${input.artifact.content}`
      : t("task.noneRecorded", locale),
    ``,
  ];
  return body.join("\n");
}

export function renderTechnicalJson(input: ResultExportInput): string {
  return JSON.stringify(
    {
      language: "en",
      task: {
        title: input.task.title,
        canonicalTaskEn: input.task.canonicalTaskEn || input.task.prompt,
        mode: input.task.mode,
      },
      provider: input.provider,
      members: input.members.map((row) => ({
        memberId: row.memberId,
        role: row.role,
        modelId: row.modelId,
        label: row.label,
      })),
      verdict: input.record.verdict,
      runStatus: input.record.runStatus,
      decisionRecord: {
        summary: input.record.summary,
        why: input.record.why,
        completed: input.record.completed,
        notCompleted: input.record.notCompleted,
        blockers: input.record.blockerNotes.length ? input.record.blockerNotes : input.record.blockers.map((row) => row.title),
        recommendations: input.record.recommendations,
        required: input.record.required,
        userActions: input.record.userActions,
        nextAction: input.record.nextAction,
        nextActionWhy: input.record.nextActionWhy,
      },
      result: input.result,
      responses: input.responses.map((row) => ({
        memberId: row.memberId,
        role: row.role,
        stage: row.stage,
        round: row.round,
        model: row.model,
        responseText: row.responseText,
        error: row.error,
      })),
      citations: input.result?.citations ?? [],
      artifact: input.artifact
        ? { id: input.artifact.id, title: input.artifact.title, version: input.artifact.version, content: input.artifact.content }
        : null,
    },
    null,
    2,
  );
}
