import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogParity, localizeErrorClass, localizeErrorMessage, statusLabel, t } from "./catalog.ts";
import { detectSourceLanguage, normalizeUiLanguage } from "./locale.ts";
import { extractCitations, maskTechnical, restoreTechnical } from "./preserve.ts";
import {
  applyRuCache,
  canonicalDisplayHash,
  citationsUnchanged,
  localizeCouncilNarrative,
  localizeDecisionRecord,
  localizeDecisionRecordStatic,
} from "./result-localize.ts";
import { prepareTaskText } from "./task-text.ts";
import type { TranslateFn } from "./translate.ts";
import type { DecisionRecord } from "../council/decision.ts";

const ruToEn: Record<string, string> = {
  "Добавь инвариант часов для механизма сопоставления": "Add the clock invariant for the matching engine",
  "Исправь формулу $E=mc^2$ в файле src/lib/foo.ts и цитату [INV:clock]. Не трогай `countTokens`.":
    "Fix the formula $E=mc^2$ in file src/lib/foo.ts and the citation [INV:clock]. Do not touch `countTokens`.",
  "Сравни GAZ-66 и Ford Fiesta Mk6: `swap_2_0_duratec` в src/lib/swap.ts":
    "Compare GAZ-66 and Ford Fiesta Mk6: `swap_2_0_duratec` in src/lib/swap.ts",
};

const enToRu: Record<string, string> = {
  "Keep inventory and matching clocks distinct.": "Держать часы inventory и matching раздельными.",
};

const fakeTranslate: TranslateFn = async ({ text, to }) => {
  const table = to === "en" ? ruToEn : enToRu;
  if (table[text]) return table[text];
  if (to === "en") return text;
  return `RU:${text}`;
};

const approved: DecisionRecord = {
  runStatus: "COMPLETE",
  verdict: "READY_FOR_REVIEW",
  summary: "The reconstructed artifact is ready for REVIEW.",
  conclusion: "The reconstructed artifact is ready for REVIEW.",
  why: "A deterministic candidate artifact was produced. This is not final approval.",
  completed: ["Keep inventory and matching clocks distinct."],
  notCompleted: [],
  agreed: ["Keep inventory and matching clocks distinct."],
  implementationState: [
    {
      module: "repository",
      status: "UNKNOWN",
      evidence: "No repository evidence selected.",
      citations: [],
    },
  ],
  blockers: [],
  blockerNotes: [],
  resolved: [],
  recommendations: [],
  required: [],
  userActions: [],
  userDecisions: [],
  implementationNotes: [],
  nextAction: "RUN_REVIEW",
  nextActionWhy: "The reconstructed artifact is ready for a REVIEW Council.",
};

describe("i18n catalog", () => {
  it("has matching EN/RU keys", () => {
    const parity = catalogParity();
    assert.deepEqual(parity.missingInRu, []);
    assert.deepEqual(parity.missingInEn, []);
  });

  it("uses natural Russian verdict labels", () => {
    assert.equal(statusLabel("READY_FOR_REVIEW", "ru"), "ГОТОВО К REVIEW");
    assert.equal(statusLabel("APPROVED", "ru"), "ПРИНЯТО");
    assert.equal(statusLabel("PATCH", "ru"), "ТРЕБУЕТ ДОРАБОТКИ");
    assert.equal(statusLabel("BLOCKED", "ru"), "ЗАБЛОКИРОВАНО");
    assert.equal(statusLabel("USER_DECISION_REQUIRED", "ru"), "НУЖНО РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ");
    assert.equal(t("label.functionBlockers", "ru"), "ФУНКЦИОНАЛЬНЫЕ БЛОКЕРЫ");
    assert.equal(t("label.workflowBlockers", "ru"), "БЛОКЕРЫ WORKFLOW");
    assert.equal(statusLabel("APPROVED", "en"), "APPROVED");
    assert.equal(t("task.delete", "en"), "Delete");
    assert.equal(t("task.delete", "ru"), "Удалить");
    assert.equal(
      localizeErrorMessage("Synthesis failed: JSON schema invalid — /status: required", "ru"),
      "Синтез не прошёл проверку JSON-схемы — /status: required",
    );
  });
});

describe("task translation", () => {
  it("keeps English tasks unchanged", async () => {
    const out = await prepareTaskText(
      { title: "Clock split", prompt: "Keep inventory and matching clocks distinct." },
      fakeTranslate,
    );
    assert.equal(out.sourceLanguage, "en");
    assert.equal(out.canonicalTaskEn, "Keep inventory and matching clocks distinct.");
    assert.equal(out.originalTask, out.canonicalTaskEn);
  });

  it("creates a faithful English canonical from Russian", async () => {
    const original = "Добавь инвариант часов для механизма сопоставления";
    const out = await prepareTaskText({ title: "Часы", prompt: original }, fakeTranslate);
    assert.equal(out.sourceLanguage, "ru");
    assert.equal(out.originalTask, original);
    assert.equal(out.canonicalTaskEn, "Add the clock invariant for the matching engine");
    assert.notEqual(out.canonicalTaskEn, out.originalTask);
  });

  it("preserves formulas, code, paths and citations in mixed tasks", async () => {
    const original =
      "Исправь формулу $E=mc^2$ в файле src/lib/foo.ts и цитату [INV:clock]. Не трогай `countTokens`.";
    const out = await prepareTaskText({ title: "Fix", prompt: original }, fakeTranslate);
    assert.equal(out.sourceLanguage, "mixed");
    assert.match(out.canonicalTaskEn, /\$E=mc\^2\$/);
    assert.match(out.canonicalTaskEn, /src\/lib\/foo\.ts/);
    assert.match(out.canonicalTaskEn, /\[INV:clock\]/);
    assert.match(out.canonicalTaskEn, /`countTokens`/);
    assert.deepEqual(extractCitations(out.originalTask), extractCitations(out.canonicalTaskEn));
  });
});

describe("technical preservation", () => {
  it("round-trips masked tokens", () => {
    const text = "See `countTokens` and [INV:clock] in src/lib/foo.ts plus COMPLETE";
    const masked = maskTechnical(text);
    assert.match(masked.masked, /⟦T\d+⟧/);
    assert.equal(restoreTechnical(masked.masked, masked.tokens), text);
  });
});

describe("result localization", () => {
  it("maps the same verdict in both languages without rerunning Council", async () => {
    const en = await localizeDecisionRecord(approved, "en", null, fakeTranslate);
    const ru = await localizeDecisionRecord(approved, "ru", null, fakeTranslate);
    assert.equal(en.view.verdict, "READY_FOR_REVIEW");
    assert.equal(ru.view.verdict, "READY_FOR_REVIEW");
    assert.equal(en.view.verdictLabel, "READY FOR REVIEW");
    assert.equal(ru.view.verdictLabel, "ГОТОВО К REVIEW");
    assert.equal(en.translated, false);
  });

  it("does not overwrite canonical English artifacts", async () => {
    const before = JSON.stringify(approved);
    const ru = await localizeDecisionRecord(approved, "ru", null, fakeTranslate);
    assert.equal(JSON.stringify(approved), before);
    assert.equal(approved.verdict, "READY_FOR_REVIEW");
    assert.equal(approved.why, "A deterministic candidate artifact was produced. This is not final approval.");
    assert.notEqual(ru.view.why, approved.why);
  });

  it("keeps citations identical across languages", async () => {
    const withCite: DecisionRecord = {
      ...approved,
      agreed: ["Keep clocks distinct [INV:clock]."],
      conclusion: "Accept with [INV:clock].",
    };
    const ru = await localizeDecisionRecord(withCite, "ru", null, async ({ text }) => `RU ${text}`);
    assert.equal(citationsUnchanged(withCite.agreed[0], ru.view.agreed[0]), true);
    assert.deepEqual(extractCitations(withCite.conclusion), extractCitations(ru.view.conclusion));
  });

  it("reuses cached Russian without translating again", async () => {
    let calls = 0;
    const counting: TranslateFn = async ({ text }) => {
      calls += 1;
      return `RU:${text}`;
    };
    const first = await localizeDecisionRecord(approved, "ru", null, counting);
    assert.ok(first.cache);
    const beforeCalls = calls;
    const second = await localizeDecisionRecord(approved, "ru", first.cache, counting);
    assert.equal(second.translated, false);
    assert.equal(second.view.fromCache, true);
    assert.equal(calls, beforeCalls);
    assert.equal(canonicalDisplayHash(approved), first.cache?.sourceHash);
    const applied = applyRuCache(approved, first.cache!);
    assert.equal(applied.verdict, "READY_FOR_REVIEW");
  });
});

describe("service vs JSON language", () => {
  it("localizes user-facing service text while JSON stays English", () => {
    const json = { model_discovery_status: "COMPLETE" };
    assert.equal(json.model_discovery_status, "COMPLETE");
    assert.equal(t("service.modelDiscoveryComplete", "ru"), "Проверка моделей завершена");
    assert.equal(t("service.modelDiscoveryComplete", "en"), "Model check finished");
    assert.equal(localizeErrorClass("TIMEOUT", "ru"), "Истекло время ожидания запроса.");
    assert.equal(localizeErrorMessage("Connection failed.", "ru"), "Подключение не удалось.");
    assert.equal(t("action.RUN_REVIEW", "ru"), "ЗАПУСТИТЬ REVIEW");
    assert.equal(detectSourceLanguage("Hello world"), "en");
    assert.equal(detectSourceLanguage("Привет мир"), "ru");
  });
});

describe("language switch contract", () => {
  it("EN view is canonical and RU view is display-only", () => {
    const en = localizeDecisionRecordStatic(approved, "en");
    const ru = localizeDecisionRecordStatic(approved, "ru");
    assert.equal(en.verdict, ru.verdict);
    assert.equal(en.nextAction, ru.nextAction);
    assert.equal(en.locale, "en");
    assert.equal(ru.locale, "ru");
    assert.equal(ru.verdictLabel, "ГОТОВО К REVIEW");
    assert.equal(ru.nextActionLabel, "ЗАПУСТИТЬ REVIEW");
    assert.equal(t("record.noUserAction", "ru"), "Действия пользователя не требуются");
    assert.equal(t("record.noneIdentified", "ru"), "Не выявлено");
    assert.equal(t("record.noBlockers", "ru"), "Блокеров нет");
    assert.equal(t("record.noneRequired", "ru"), "Не требуется");
    assert.equal(t("record.completed", "ru"), "Что сделано");
    assert.equal(t("record.notCompleted", "ru"), "Что не сделано");
    assert.equal(t("record.implementation", "ru"), "Состояние реализации");
    assert.equal(t("record.outcome", "ru"), "Итог");
    assert.equal(t("record.blockers", "ru"), "В чём затык");
    assert.equal(t("record.recommendations", "ru"), "Рекомендовано");
    assert.equal(t("record.required", "ru"), "Требуется");
    assert.equal(t("record.userActions", "ru"), "Действия пользователя");
    assert.equal(t("record.next", "ru"), "Следующий шаг");
    assert.equal(t("follow.CREATE_PATCH", "ru"), "Откроет новую задачу CREATE, чтобы Совет выполнил свой же следующий шаг. Пока ничего не замораживается.");
    assert.equal(t("action.CREATE_PATCH", "ru"), "СОЗДАТЬ ПАТЧ");
    assert.equal(t("fold.modelPosition", "ru"), "Позиция модели");
    assert.equal(t("fold.crossReview", "ru"), "Перекрёстный разбор");
    assert.equal(t("fold.finalFinding", "ru"), "Итоговый вывод");
    assert.equal(t("fold.originalEn", "ru"), "Оригинал на английском");
    assert.equal(t("fold.alternatives", "ru"), "Альтернативы");
    assert.equal(t("fold.disagreements", "ru"), "Разногласия");
    assert.equal(t("fold.corrections", "ru"), "Предложенные правки");
    assert.equal(t("fold.resolvedIssues", "ru"), "Снятые замечания");
    assert.equal(t("fold.openFollowups", "ru"), "Открытые хвосты");
    assert.equal(t("operator.working", "ru"), "СОВЕТ РАБОТАЕТ");
    assert.equal(t("operator.complete", "ru"), "СОВЕТ ЗАВЕРШЁН");
    assert.equal(en.nextAction, "RUN_REVIEW");
    assert.equal(ru.nextAction, "RUN_REVIEW");
    assert.deepEqual(en.implementationState.map((row) => row.status), ru.implementationState.map((row) => row.status));
  });

  it("defaults existing accounts to EN and accepts RU", () => {
    assert.equal(normalizeUiLanguage(undefined), "en");
    assert.equal(normalizeUiLanguage("en"), "en");
    assert.equal(normalizeUiLanguage("ru"), "ru");
    assert.equal(normalizeUiLanguage("de"), "en");
  });

  it("RU narrative is a display cache and does not rerun Council", async () => {
    const result = {
      taskId: "t",
      status: "READY_FOR_REVIEW",
      consensus: ["ok"],
      disagreements: ["clock split"],
      blockers: [],
      recommendation: "review the artifact",
      agentPositions: { m1: "keep inventory clock" },
      synthesisRaw: '{"status":"READY_FOR_REVIEW"}',
      synthesizerProposedStatus: "READY_FOR_REVIEW",
      finalEnforcedStatus: "READY_FOR_REVIEW",
      reconciledStatus: "READY_FOR_REVIEW",
      verdictOverride: false,
      overrideReason: null,
      decision: "ready",
      rationale: "evidence holds",
      dissent: [],
      reviewVerdict: null,
      alternatives: [],
      evidence: [],
      risks: [],
      issues: ["P1 document the swap"],
      proposedCorrections: [],
      resolvedIssues: ["P0 clock split is closed"],
      unresolvedIssues: ["P1 document the swap"],
      citations: ["INV:clock"],
      failedAgents: [],
    };
    const responses = [
      {
        id: "r1",
        taskId: "t",
        memberId: "m1",
        agent: "m1",
        role: "LEAD_REASONER",
        round: 1,
        stage: "ROUND_1",
        model: "test",
        dispatchedModelId: "test",
        provider: "openrouter",
        promptSnapshot: "",
        responseText: "POSITION keep inventory clock",
        structured: null,
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
        cost: 0,
        requestId: "r1",
        latencyMs: 1,
        attempt: 1,
        error: null,
        contextManifestId: null,
        contextHash: null,
        runId: "run-1",
      },
    ];
    let calls = 0;
    const counting: TranslateFn = async ({ text }) => {
      calls += 1;
      return `RU:${text}`;
    };
    const first = await localizeCouncilNarrative(result as never, responses as never, "ru", null, counting);
    assert.equal(first.translated, true);
    assert.match(first.view.round1.m1, /^RU:/);
    assert.match(first.view.recommendation, /^RU:/);
    assert.equal(first.view.locale, "ru");
    const before = calls;
    const second = await localizeCouncilNarrative(result as never, responses as never, "ru", first.cache, counting);
    assert.equal(second.translated, false);
    assert.equal(second.view.fromCache, true);
    assert.equal(calls, before);
    const en = await localizeCouncilNarrative(result as never, responses as never, "en", first.cache, counting);
    assert.equal(en.translated, false);
    assert.equal(en.view.recommendation, "review the artifact");
    assert.equal(en.view.round1.m1, "POSITION keep inventory clock");
  });
});
