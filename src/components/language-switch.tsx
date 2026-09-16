import { useI18n } from "@/lib/i18n/provider";
import type { UiLanguage } from "@/lib/i18n/locale";

export function LanguageSwitch({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();

  function onPick(next: UiLanguage) {
    if (next === locale) return;
    setLocale(next);
  }

  return (
    <div
      role="group"
      aria-label={t("nav.language")}
      className={`inline-flex min-h-11 shrink-0 items-center rounded-full border border-line bg-subtle px-1 ${className}`}
    >
      <button
        type="button"
        aria-pressed={locale === "ru"}
        className={`min-h-9 min-w-11 rounded-full px-3 text-xs font-semibold tracking-wide ${
          locale === "ru" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
        }`}
        onClick={() => onPick("ru")}
      >
        RU
      </button>
      <span className="px-1 text-xs text-faint" aria-hidden="true">
        |
      </span>
      <button
        type="button"
        aria-pressed={locale === "en"}
        className={`min-h-9 min-w-11 rounded-full px-3 text-xs font-semibold tracking-wide ${
          locale === "en" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
        }`}
        onClick={() => onPick("en")}
      >
        EN
      </button>
    </div>
  );
}
