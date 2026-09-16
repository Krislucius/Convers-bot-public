import type { DecisionRecord } from "../council/decision.ts";
import { actionLabel, statusLabel, t } from "./catalog.ts";
import type { UiLanguage } from "./locale.ts";
import { extractCitations } from "./preserve.ts";
import { translateOrThrow, type TranslateFn } from "./translate.ts";

export type LocalizedDecisionView = DecisionRecord & {
  verdictLabel: string | null;
  nextActionLabel: string | null;
  locale: UiLanguage;
  fromCache: boolean;
};

const STATIC_WHY: Record<string, string> = {
  "Council did not produce a synthesis.": "Совет не подготовил синтез.",
  "Unresolved P0 findings remain.": "Остаются неснятые P0.",
  "A material fix is required; no P0 remains.": "Нужна существенная доработка; P0 больше нет.",
  "A choice remains that only the operator can make.": "Остаётся выбор, который может сделать только оператор.",
  "No unresolved blocking issues remain.": "Неснятых блокирующих замечаний нет.",
  "Council failed before synthesis.": "Совет завершился сбоем до синтеза.",
  "The run was cancelled before synthesis.": "Запуск отменён до синтеза.",
  "Council did not produce a task verdict.": "Совет не вынес вердикт по задаче.",
  "A deterministic candidate artifact was produced. This is not final approval.":
    "Собран детерминированный кандидат-артефакт. Это ещё не окончательное принятие.",
};

const STATIC_CONCLUSION: Record<string, string> = {
  "No task verdict — Council did not finish.": "Вердикта нет — Совет не завершился.",
  "Cannot accept: unresolved P0 remains.": "Нельзя принять: остаётся неснятый P0.",
  "Apply the listed corrections, then re-run REVIEW.": "Внесите указанные правки и повторите REVIEW.",
  "Council needs an operator choice.": "Совету нужно решение оператора.",
  "The reconstructed artifact is accepted.": "Восстановленный артефакт принят.",
  "The candidate is accepted.": "Кандидат принят.",
  "No task verdict — Council was cancelled.": "Вердикта нет — Совет отменён.",
  "The reconstructed artifact is ready for REVIEW.": "Восстановленный артефакт готов к REVIEW.",
};

const STATIC_NEXT_WHY: Record<string, string> = {
  "Council did not produce a task verdict.": "Совет не вынес вердикт по задаче.",
  "An operator choice is required before work can continue.": "Прежде чем продолжать, нужно решение оператора.",
  "Unresolved P0 depends on missing or conflicted evidence.": "Неснятый P0 зависит от отсутствующих или противоречивых свидетельств.",
  "Unresolved P0 must be fixed before the result can be accepted.": "Неснятый P0 нужно закрыть, прежде чем принимать результат.",
  "A material fix is required; no P0 remains.": "Нужна существенная доработка; P0 больше нет.",
  "The reconstructed artifact is ready for a REVIEW Council.": "Восстановленный артефакт готов к Совету REVIEW.",
  "No unresolved blocking issues remain.": "Неснятых блокирующих замечаний нет.",
  "The candidate is ready for review. Attach an authoritative repository to verify implementation.":
    "Кандидат готов к review. Приложите авторитетный репозиторий, чтобы проверить реализацию.",
  "Selected repository snapshots conflict. Choose one authoritative source tree.":
    "Выбранные снимки репозитория конфликтуют. Оставьте один авторитетный исходный код.",
  "No further Council action is required.": "Дальнейших действий Совета не требуется.",
};

const P0_WHY_EN = "Unresolved P0. Acceptance requires this issue to be resolved or rejected.";
const P0_WHY_RU = "Неснятый P0. Чтобы принять результат, замечание нужно снять или отклонить.";

function fnv1a(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function canonicalDisplayHash(record: DecisionRecord): string {
  return fnv1a(
    JSON.stringify({
      runStatus: record.runStatus,
      verdict: record.verdict,
      summary: record.summary,
      conclusion: record.conclusion,
      why: record.why,
      completed: record.completed,
      notCompleted: record.notCompleted,
      agreed: record.agreed,
      implementationState: record.implementationState.map((row) => ({
        module: row.module,
        status: row.status,
        evidence: row.evidence,
        citations: row.citations,
      })),
      blockers: record.blockers.map((row) => ({
        issueId: row.issueId,
        title: row.title,
        severity: row.severity,
        why: row.why,
        evidenceRefs: row.evidenceRefs,
        resolveCondition: row.resolveCondition,
      })),
      resolved: record.resolved,
      recommendations: record.recommendations,
      required: record.required,
      userActions: record.userActions,
      userDecisions: record.userDecisions,
      nextAction: record.nextAction,
      nextActionWhy: record.nextActionWhy,
    }),
  );
}

export type CachedRuLocalization = {
  sourceHash: string;
  summary: string;
  conclusion: string;
  why: string;
  completed: string[];
  notCompleted: string[];
  agreed: string[];
  implementationEvidence: Array<{ module: string; evidence: string }>;
  blockers: Array<{ issueId: string; title: string; why: string; resolveCondition: string }>;
  resolved: Array<{ issueId: string; title: string; reason: string }>;
  recommendations: string[];
  required: string[];
  userActions: string[];
  userDecisions: string[];
  nextActionWhy: string;
};

function staticText(en: string, table: Record<string, string>): string {
  return table[en] ?? en;
}

export function localizeDecisionRecordStatic(record: DecisionRecord, locale: UiLanguage): LocalizedDecisionView {
  if (locale !== "ru") {
    return {
      ...record,
      verdictLabel: record.verdict ? statusLabel(record.verdict, "en") : null,
      nextActionLabel: record.nextAction ? actionLabel(record.nextAction, "en") : null,
      locale: "en",
      fromCache: true,
    };
  }
  return {
    ...record,
    summary: staticText(record.summary, STATIC_CONCLUSION),
    conclusion: staticText(record.conclusion, STATIC_CONCLUSION),
    why: staticText(record.why, STATIC_WHY),
    nextActionWhy: staticText(record.nextActionWhy, STATIC_NEXT_WHY),
    blockers: record.blockers.map((row) => ({
      ...row,
      why: row.why === P0_WHY_EN ? P0_WHY_RU : row.why,
    })),
    verdictLabel: record.verdict ? statusLabel(record.verdict, "ru") : null,
    nextActionLabel: record.nextAction ? actionLabel(record.nextAction, "ru") : null,
    locale: "ru",
    fromCache: false,
  };
}

export function applyRuCache(record: DecisionRecord, cache: CachedRuLocalization): LocalizedDecisionView {
  const byIssue = new Map(cache.blockers.map((row) => [row.issueId, row]));
  const resolvedBy = new Map(cache.resolved.map((row) => [row.issueId, row]));
  const implBy = new Map((cache.implementationEvidence ?? []).map((row) => [row.module, row.evidence]));
  return {
    ...record,
    summary: cache.summary ?? cache.conclusion,
    conclusion: cache.conclusion,
    why: cache.why,
    completed: cache.completed ?? cache.agreed,
    notCompleted: cache.notCompleted ?? record.notCompleted,
    agreed: cache.agreed,
    implementationState: record.implementationState.map((row) => ({
      ...row,
      evidence: implBy.get(row.module) ?? row.evidence,
    })),
    blockers: record.blockers.map((row) => {
      const hit = byIssue.get(row.issueId);
      return {
        ...row,
        title: hit?.title ?? row.title,
        why: hit?.why ?? (row.why === P0_WHY_EN ? P0_WHY_RU : row.why),
        resolveCondition: hit?.resolveCondition ?? row.resolveCondition,
      };
    }),
    resolved: record.resolved.map((row) => {
      const hit = resolvedBy.get(row.issueId);
      return {
        ...row,
        title: hit?.title ?? row.title,
        reason: hit?.reason ?? row.reason,
      };
    }),
    recommendations: cache.recommendations ?? record.recommendations,
    required: cache.required ?? record.required,
    userActions: cache.userActions ?? record.userActions,
    userDecisions: cache.userDecisions,
    nextActionWhy: cache.nextActionWhy,
    verdictLabel: record.verdict ? statusLabel(record.verdict, "ru") : null,
    nextActionLabel: record.nextAction ? actionLabel(record.nextAction, "ru") : null,
    locale: "ru",
    fromCache: true,
  };
}

async function translateFree(text: string, translate: TranslateFn): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (STATIC_WHY[trimmed]) return STATIC_WHY[trimmed];
  if (STATIC_CONCLUSION[trimmed]) return STATIC_CONCLUSION[trimmed];
  if (STATIC_NEXT_WHY[trimmed]) return STATIC_NEXT_WHY[trimmed];
  if (trimmed === P0_WHY_EN) return P0_WHY_RU;
  return translateOrThrow({ text: trimmed, from: "en", to: "ru" }, translate);
}

export async function localizeDecisionRecord(
  record: DecisionRecord,
  locale: UiLanguage,
  cache: CachedRuLocalization | null | undefined,
  translate: TranslateFn,
): Promise<{ view: LocalizedDecisionView; cache: CachedRuLocalization | null; translated: boolean }> {
  if (locale !== "ru") {
    return { view: localizeDecisionRecordStatic(record, "en"), cache: cache ?? null, translated: false };
  }
  const hash = canonicalDisplayHash(record);
  if (cache && cache.sourceHash === hash) {
    return { view: applyRuCache(record, cache), cache, translated: false };
  }
  const staticView = localizeDecisionRecordStatic(record, "ru");
  const next: CachedRuLocalization = {
    sourceHash: hash,
    summary: await translateFree(record.summary || record.conclusion, translate),
    conclusion: await translateFree(record.conclusion, translate),
    why: staticView.why,
    completed: await Promise.all((record.completed.length ? record.completed : record.agreed).map((row) => translateFree(row, translate))),
    notCompleted: await Promise.all(record.notCompleted.map((row) => translateFree(row, translate))),
    agreed: await Promise.all(record.agreed.map((row) => translateFree(row, translate))),
    implementationEvidence: await Promise.all(
      record.implementationState.map(async (row) => ({
        module: row.module,
        evidence: await translateFree(row.evidence, translate),
      })),
    ),
    blockers: await Promise.all(
      record.blockers.map(async (row) => ({
        issueId: row.issueId,
        title: await translateFree(row.title, translate),
        why: row.why === P0_WHY_EN ? P0_WHY_RU : await translateFree(row.why, translate),
        resolveCondition: await translateFree(row.resolveCondition, translate),
      })),
    ),
    resolved: await Promise.all(
      record.resolved.map(async (row) => ({
        issueId: row.issueId,
        title: await translateFree(row.title, translate),
        reason: await translateFree(row.reason, translate),
      })),
    ),
    recommendations: await Promise.all(record.recommendations.map((row) => translateFree(row, translate))),
    required: await Promise.all(record.required.map((row) => translateFree(row, translate))),
    userActions: await Promise.all(record.userActions.map((row) => translateFree(row, translate))),
    userDecisions: await Promise.all(record.userDecisions.map((row) => translateFree(row, translate))),
    nextActionWhy: staticView.nextActionWhy,
  };
  return { view: applyRuCache(record, next), cache: next, translated: true };
}

export function citationsUnchanged(original: string, localized: string): boolean {
  return extractCitations(original).join("\n") === extractCitations(localized).join("\n");
}

export function translatingLabel(locale: UiLanguage): string {
  return t("record.translating", locale);
}
