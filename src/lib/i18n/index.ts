export { DEFAULT_UI_LANGUAGE, detectSourceLanguage, isUiLanguage, LANGUAGE_STORAGE_KEY, needsEnglishCanonical, normalizeUiLanguage, type SourceLanguage, type UiLanguage } from "./locale.ts";
export { t, statusLabel, actionLabel, localizeErrorMessage, localizeErrorClass, catalogParity, interpolate } from "./catalog.ts";
export { prepareTaskText, councilTaskText, type PreparedTaskText } from "./task-text.ts";
export {
  applyRuCache,
  canonicalDisplayHash,
  citationsUnchanged,
  localizeDecisionRecord,
  localizeDecisionRecordStatic,
  type CachedRuLocalization,
  type LocalizedDecisionView,
} from "./result-localize.ts";
export { I18nProvider, useI18n } from "./provider";
