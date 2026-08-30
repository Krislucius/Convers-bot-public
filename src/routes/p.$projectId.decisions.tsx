import { createFileRoute } from "@tanstack/react-router";
import { MemoryPanel } from "@/components/memory-panel";

export const Route = createFileRoute("/p/$projectId/decisions")({ component: DecisionsPage });

function DecisionsPage() {
  const { projectId } = Route.useParams();
  return (
    <MemoryPanel
      projectId={projectId}
      title="Decisions"
      kinds={["DECISION"]}
      allowAdd
      lockKind="DECISION"
      lockStatus="ACTIVE"
    />
  );
}
