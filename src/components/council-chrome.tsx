import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Circle, CircleDot } from "lucide-react";
import { providerName } from "@/lib/council/providers";
import { useSession } from "@/lib/council/session";

export function CouncilChrome({ account }: { account?: ReactNode }) {
  const { config } = useSession();
  const name = providerName(config.provider);
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex min-h-14 w-full max-w-page flex-wrap items-center justify-between gap-3 px-4 py-2">
        <nav className="flex flex-wrap items-center gap-4">
          <Link
            to="/"
            className="font-sans text-xs font-semibold tracking-widest text-muted uppercase no-underline hover:text-fg"
          >
            Conversation Bot
          </Link>
          <Link to="/settings" className="text-sm text-fg no-underline hover:text-accent">
            API Settings
          </Link>
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          {account}
          <Link
            to="/settings"
            className={`inline-flex min-h-11 items-center gap-2 rounded-full bg-subtle px-3 py-2 text-xs font-semibold tracking-wide no-underline ${
              config.ready ? "text-ok" : "text-danger"
            }`}
          >
            {config.ready ? <CircleDot className="size-3.5" aria-hidden="true" /> : <Circle className="size-3.5" aria-hidden="true" />}
            {name} {config.ready ? "READY" : "NOT CONNECTED"}
          </Link>
        </div>
      </div>
    </header>
  );
}
