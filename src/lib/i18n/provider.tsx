import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { t as translateKey, statusLabel as formatStatus, localizeErrorMessage } from "./catalog.ts";
import { DEFAULT_UI_LANGUAGE, LANGUAGE_STORAGE_KEY, normalizeUiLanguage, type UiLanguage } from "./locale.ts";

type I18nApi = {
  locale: UiLanguage;
  setLocale: (next: UiLanguage) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  status: (value: string) => string;
  error: (message: string) => string;
};

const I18nContext = createContext<I18nApi | null>(null);

function readStoredLocale(): UiLanguage {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    return normalizeUiLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

function writeStoredLocale(locale: UiLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    /* ignore quota */
  }
}

export function I18nProvider({
  language,
  onChange,
  children,
}: {
  language?: UiLanguage | null;
  onChange?: (next: UiLanguage) => void;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<UiLanguage>(() =>
    language ? normalizeUiLanguage(language) : readStoredLocale(),
  );

  useEffect(() => {
    if (language) setLocaleState(normalizeUiLanguage(language));
  }, [language]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale === "ru" ? "ru" : "en";
    writeStoredLocale(locale);
  }, [locale]);

  const setLocale = useCallback(
    (next: UiLanguage) => {
      const normalized = normalizeUiLanguage(next);
      setLocaleState(normalized);
      writeStoredLocale(normalized);
      onChange?.(normalized);
    },
    [onChange],
  );

  const api = useMemo<I18nApi>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translateKey(key, locale, vars),
      status: (value) => formatStatus(value, locale),
      error: (message) => localizeErrorMessage(message, locale),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

const FALLBACK: I18nApi = {
  locale: DEFAULT_UI_LANGUAGE,
  setLocale: () => undefined,
  t: (key, vars) => translateKey(key, DEFAULT_UI_LANGUAGE, vars),
  status: (value) => formatStatus(value, DEFAULT_UI_LANGUAGE),
  error: (message) => localizeErrorMessage(message, DEFAULT_UI_LANGUAGE),
};

export function useI18n(): I18nApi {
  return useContext(I18nContext) ?? FALLBACK;
}
