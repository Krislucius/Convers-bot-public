import { Link } from "@tanstack/react-router";
import { useStore } from "@/lib/council/store";

const TABS = [
  { to: "/p/$projectId" as const, label: "Tasks", exact: true },
  { to: "/p/$projectId/chats" as const, label: "AI Chats", exact: false },
  { to: "/p/$projectId/files" as const, label: "Files", exact: true },
  { to: "/p/$projectId/memory" as const, label: "Memory", exact: true },
  { to: "/p/$projectId/decisions" as const, label: "Decisions", exact: true },
  { to: "/p/$projectId/invariants" as const, label: "Invariants", exact: true },
];

export function ProjectNav({ projectId }: { projectId: string }) {
  const store = useStore();
  const chatCount = store.chatSources.filter(
    (row) => row.projectId === projectId && row.importStatus !== "ARCHIVED",
  ).length;
  const fileCount = store.projectFiles.filter((row) => row.projectId === projectId).length;
  const taskCount = store.tasks.filter((row) => row.projectId === projectId).length;

  return (
    <nav className="mb-2 flex flex-wrap gap-1 border-b border-line" aria-label="Project sections">
      {TABS.map((tab) => (
        <Link
          key={tab.label}
          to={tab.to}
          params={{ projectId }}
          activeOptions={{ exact: tab.exact }}
          className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted no-underline hover:text-fg"
          activeProps={{ className: "border-accent text-fg" }}
        >
          {tab.label}
          {tab.label === "AI Chats" && chatCount ? (
            <span className="ml-2 text-xs text-faint tabular-nums">{chatCount}</span>
          ) : null}
          {tab.label === "Files" && fileCount ? (
            <span className="ml-2 text-xs text-faint tabular-nums">{fileCount}</span>
          ) : null}
          {tab.label === "Tasks" && taskCount ? (
            <span className="ml-2 text-xs text-faint tabular-nums">{taskCount}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
