import { createFileRoute } from "@tanstack/react-router";
import { MemoryPanel } from "@/components/memory-panel";

export const Route = createFileRoute("/p/$projectId/memory")({ component: MemoryPage });

function MemoryPage() {
  const { projectId } = Route.useParams();
  return (
    <MemoryPanel
      projectId={projectId}
      title="Canonical memory"
      kinds={["SPECIFICATION", "PROJECT_STATE"]}
      allowAdd
    />
  );
}
