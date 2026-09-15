import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Circle, CircleDot } from "lucide-react";
import { LanguageSwitch } from "@/components/language-switch";
import { providerName } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";
import { useI18n } from "@/lib/i18n/provider";

export function CouncilChrome({ account }: { account?: ReactNode }) {
  const { config } = useSession();
  const { t } = useI18n();
  const name = providerName(config.provider);
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex min-h-14 w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-2">
        <nav className="flex flex-wrap items-center gap-4">
          <Link
            to="/"
            className="font-sans text-xs font-semibold tracking-widest text-muted uppercase no-underline hover:text-fg"
          >
            {t("app.name")}
          </Link>
          <Link to="/settings" className="text-sm text-fg no-underline hover:text-accent">
            {t("nav.settings")}
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <LanguageSwitch />
          {account}
          <Link
            to="/settings"
            className={`inline-flex min-h-11 items-center gap-2 rounded-full bg-subtle px-3 py-2 text-xs font-semibold tracking-wide no-underline ${
              config.ready ? "text-ok" : "text-danger"
            }`}
          >
            {config.ready ? <CircleDot className="size-3.5" aria-hidden="true" /> : <Circle className="size-3.5" aria-hidden="true" />}
            {name} {config.ready ? t("status.ready") : t("status.notConnected")}
          </Link>
        </div>
      </div>
    </header>
  );
}