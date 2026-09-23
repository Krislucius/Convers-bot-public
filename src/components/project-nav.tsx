import { Link } from "@tanstack/react-router";
import { useStore } from "@/lib/council/store";
import { useI18n } from "@/lib/i18n/provider";

export function ProjectNav({ projectId }: { projectId: string }) {
  const store = useStore();
  const { t } = useI18n();
  const chatCount = store.chatSources.filter(
    (row) => row.projectId === projectId && row.importStatus !== "ARCHIVED",
  ).length;
  const fileCount = store.projectFiles.filter((row) => row.projectId === projectId).length;
  const taskCount = store.tasks.filter((row) => row.projectId === projectId).length;
  const tabs = [
    { to: "/p/$projectId" as const, key: "nav.tasks", exact: true, count: taskCount },
    { to: "/p/$projectId/solo" as const, key: "nav.solo", exact: true, count: 0 },
    { to: "/p/$projectId/chats" as const, key: "nav.chats", exact: false, count: chatCount },
    { to: "/p/$projectId/files" as const, key: "nav.files", exact: true, count: fileCount },
    { to: "/p/$projectId/memory" as const, key: "nav.memory", exact: true, count: 0 },
    { to: "/p/$projectId/decisions" as const, key: "nav.decisions", exact: true, count: 0 },
    { to: "/p/$projectId/invariants" as const, key: "nav.invariants", exact: true, count: 0 },
  ];

  return (
    <nav className="mb-2 flex flex-wrap gap-1 border-b border-line" aria-label={t("nav.tasks")}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          to={tab.to}
          params={{ projectId }}
          activeOptions={{ exact: tab.exact }}
          className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted no-underline hover:text-fg"
          activeProps={{ className: "border-accent text-fg" }}
        >
          {t(tab.key)}
          {tab.count ? <span className="ml-2 text-xs text-faint tabular-nums">{tab.count}</span> : null}
        </Link>
      ))}
    </nav>
  );
}