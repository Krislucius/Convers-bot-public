import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogParity, localizeErrorClass, localizeErrorMessage, statusLabel, t } from "./catalog.ts";
import { detectSourceLanguage, normalizeUiLanguage } from "./locale.ts";
import { extractCitations, maskTechnical, restoreTechnical } from "./preserve.ts";
import {
  applyRuCache,
  canonicalDisplayHash,
  citationsUnchanged,
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
  verdict: "APPROVED",
  conclusion: "The reconstructed artifact is accepted.",
  why: "No unresolved blocking issues remain.",
  agreed: ["Keep inventory and matching clocks distinct."],
  blockers: [],
  resolved: [],
  userDecisions: [],
  nextAction: "RUN REVIEW",
  nextActionWhy: "The reconstructed artifact is ready for a REVIEW Council.",
};

describe("i18n catalog", () => {
  it("has matching EN/RU keys", () => {
    const parity = catalogParity();
    assert.deepEqual(parity.missingInRu, []);
    assert.deepEqual(parity.missingInEn, []);
  });

  it("uses natural Russian verdict labels", () => {
    assert.equal(statusLabel("APPROVED", "ru"), "ПРИНЯТО");
    assert.equal(statusLabel("PATCH", "ru"), "ТРЕБУЕТ ДОРАБОТКИ");
    assert.equal(statusLabel("BLOCKED", "ru"), "ЗАБЛОКИРОВАНО");
    assert.equal(statusLabel("USER_DECISION_REQUIRED", "ru"), "НУЖНО РЕШЕНИЕ ПОЛЬЗОВАТЕЛЯ");
    assert.equal(t("label.functionBlockers", "ru"), "ФУНКЦИОНАЛЬНЫЕ БЛОКЕРЫ");
    assert.equal(t("label.workflowBlockers", "ru"), "БЛОКЕРЫ WORKFLOW");
    assert.equal(statusLabel("APPROVED", "en"), "APPROVED");
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
    assert.equal(en.view.verdict, "APPROVED");
    assert.equal(ru.view.verdict, "APPROVED");
    assert.equal(en.view.verdictLabel, "APPROVED");
    assert.equal(ru.view.verdictLabel, "ПРИНЯТО");
    assert.equal(en.translated, false);
  });

  it("does not overwrite canonical English artifacts", async () => {
    const before = JSON.stringify(approved);
    const ru = await localizeDecisionRecord(approved, "ru", null, fakeTranslate);
    assert.equal(JSON.stringify(approved), before);
    assert.equal(approved.verdict, "APPROVED");
    assert.equal(approved.why, "No unresolved blocking issues remain.");
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
    assert.equal(applied.verdict, "APPROVED");
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
    assert.equal(ru.verdictLabel, "ПРИНЯТО");
    assert.equal(ru.nextActionLabel, "ЗАПУСТИТЬ REVIEW");
  });

  it("defaults existing accounts to EN and accepts RU", () => {
    assert.equal(normalizeUiLanguage(undefined), "en");
    assert.equal(normalizeUiLanguage("en"), "en");
    assert.equal(normalizeUiLanguage("ru"), "ru");
    assert.equal(normalizeUiLanguage("de"), "en");
  });
});
