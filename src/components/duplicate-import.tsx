import { GhostButton, Panel, PrimaryButton } from "@/components/council-ui";
import type { ChatSource } from "@/lib/history/types";

export type DuplicateChoice = "cancel" | "replace" | "separate";

export function DuplicateImport({
  existing,
  onChoose,
}: {
  existing: ChatSource;
  onChoose: (choice: DuplicateChoice) => void;
}) {
  return (
    <Panel>
      <h2 className="font-display mb-2 text-lg">This content appears to already exist in this project.</h2>
      <p className="text-muted">Existing source: {existing.title}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <GhostButton type="button" onClick={() => onChoose("cancel")}>
          Cancel
        </GhostButton>
        <GhostButton type="button" onClick={() => onChoose("replace")}>
          Replace existing
        </GhostButton>
        <PrimaryButton type="button" onClick={() => onChoose("separate")}>
          Import as separate source
        </PrimaryButton>
      </div>
    </Panel>
  );
}
