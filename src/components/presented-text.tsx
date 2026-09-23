import { CollapsibleText } from "@/components/collapsible-text";
import { useI18n } from "@/lib/i18n/provider";

export function PresentedText({
  original,
  localized,
  defaultCollapsed,
  forceOpen,
}: {
  original: string;
  localized?: string | null;
  defaultCollapsed?: boolean;
  forceOpen?: boolean | null;
}) {
  const { t, locale } = useI18n();
  const shown = locale === "ru" && localized && localized.trim() ? localized : original;
  const showOriginal = locale === "ru" && original && shown !== original;
  return (
    <div>
      <CollapsibleText text={shown || "—"} defaultCollapsed={defaultCollapsed} forceOpen={forceOpen} />
      {showOriginal ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-semibold tracking-widest text-faint uppercase">
            {t("fold.originalEn")}
          </summary>
          <div className="mt-2">
            <CollapsibleText text={original} defaultCollapsed forceOpen={forceOpen} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
