import { createFileRoute } from "@tanstack/react-router";
import { MemoryPanel } from "@/components/memory-panel";

export const Route = createFileRoute("/p/$projectId/invariants")({ component: InvariantsPage });

function InvariantsPage() {
  const { projectId } = Route.useParams();
  return (
    <MemoryPanel
      projectId={projectId}
      title="Invariants"
      kinds={["INVARIANT"]}
      allowAdd
      lockKind="INVARIANT"
      lockStatus="FROZEN"
    />
  );
}
