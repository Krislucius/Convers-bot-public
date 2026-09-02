import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { CouncilFold } from "@/components/council-fold";
import { SourcePicker } from "@/components/source-picker";
import { FilePicker } from "@/components/file-picker";
import { EvidenceCoveragePanel } from "@/components/evidence-coverage";
import { Panel, PrimaryButton, StatusPill } from "@/components/council-ui";
import { CONTEXT_TOKEN_LIMIT, estimateCouncilRun } from "@/lib/council/protocol";
import { patchTask } from "@/lib/council/store";
import { councilPreflight } from "@/lib/council/task-mode";
import type { Artifact, ContextItem, Project, ProjectFile, Task } from "@/lib/council/types";
import { coverageBlocksCouncil } from "@/lib/evidence/pipeline";
import { cachedEvidencePipeline, type EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { ledgerFoldLabelFromManifest } from "@/lib/evidence/preview";
import { formatTokens, formatUsd } from "@/lib/history/format";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export function CouncilRunPanel({
  project,
  task,
  frozen,
  chatSources,
  historyMessages,
  artifacts,
  maxCostUsd,
  ready,
  providerLabel,
  busy,
  message,
  onRun,
  projectFiles,
}: {
  project: Project;
  task: Task;
  frozen: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  artifacts: Artifact[];
  maxCostUsd: number;
  ready: boolean;
  providerLabel: string;
  busy: boolean;
  message: string;
  onRun: (pipeline: EvidencePipelineResult) => void;
  projectFiles?: ProjectFile[];
}) {
  const candidate = artifacts.find((row) => row.id === task.candidateArtifactId) ?? null;
  const pipeline = cachedEvidencePipeline({
    project,
    task,
    frozen,
    chatSources,
    historyMessages,
    projectFiles: projectFiles ?? [],
    candidateText: candidate ? `# ${candidate.title} v${candidate.version}\n\n${candidate.content}` : null,
  });
  const ctx = pipeline.pack.ok ? pipeline.pack.text : "";
  const estimate = estimateCouncilRun(ctx, maxCostUsd);
  const budget = maxCostUsd > 0 ? maxCostUsd : 1;
  const precheck = councilPreflight({ task, artifacts });
  const coverageError = coverageBlocksCouncil(pipeline.coverage);
  const budgetError = pipeline.pack.ok ? null : "Mandatory context exceeds the Council token budget.";
  const canPay = ready && precheck.ok && !busy && !coverageError && !budgetError;
  const audit = pipeline.manifest.audit;
  const selectedFiles = (task.selectedFileIds ?? []).length;
  const ledgerSummary = ledgerFoldLabelFromManifest(pipeline.manifest);

  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Council run</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-display m-0 text-xl">Council setup</h2>
        <StatusPill status={task.mode} />
        {task.requiresHistoricalContext ? <span className="text-xs text-faint">historical context required</span> : null}
      </div>

      <dl className="m-0 grid grid-cols-3 gap-2 lg:grid-cols-5">
        <Stat label="Mode" value={task.mode} />
        <Stat label="Selected chats" value={String(task.selectedChatSourceIds.length)} />
        <Stat label="Selected files" value={String(selectedFiles)} />
        <Stat label="Estimated context" value={formatTokens(estimate.inputTokens)} />
        <Stat label="Estimated cost" value={formatUsd(estimate.costUsd)} warn={estimate.overBudget} />
        <Stat label="Coverage" value={pipeline.manifest.coverageStatus} />
        <Stat label="Chunks processed" value={String(audit.chunksProcessed)} />
        <Stat label="Evidence claims" value={String(audit.evidenceCount)} />
        <Stat label="Packed evidence" value={String(audit.packedEvidence)} />
      </dl>

      {pipeline.pack.omitted.length > 0 ? (
        <p className="mt-3 mb-0 text-sm text-warn">
          Packed {pipeline.pack.packed.length} claims ({formatTokens(estimate.inputTokens)} / {formatTokens(CONTEXT_TOKEN_LIMIT)}
          ). Omitted {pipeline.pack.omitted.length} ranked claims after every selected chunk was processed.
        </p>
      ) : null}

      {estimate.overBudget ? (
        <p className="mt-3 mb-0 text-sm text-warn">
          Estimated cost exceeds the {formatUsd(budget)} limit in API Settings. Council will stop if the limit is reached.
        </p>
      ) : null}

      {task.mode === "REVIEW" && candidate ? (
        <p className="mt-3 mb-0 text-sm text-muted">
          Candidate artifact: <span className="text-fg">{candidate.title}</span> v{candidate.version}
        </p>
      ) : null}

      {!precheck.ok ? (
        <p className="mt-3 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{precheck.error}</p>
      ) : null}
      {coverageError ? (
        <p className="mt-3 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{coverageError}</p>
      ) : null}
      {budgetError ? (
        <p className="mt-3 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{budgetError}</p>
      ) : null}

      <div className="sticky top-0 z-10 mt-4 border-y border-line bg-elevated py-3">
        {ready ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 text-ok">Council Ready</p>
              <ul className="m-0 flex list-none flex-wrap gap-3 p-0 text-sm">
                <li className="inline-flex items-center gap-1.5">
                  <Check className="size-4 text-ok" aria-hidden="true" /> GPT
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <Check className="size-4 text-ok" aria-hidden="true" /> Grok
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <Check className="size-4 text-ok" aria-hidden="true" /> Claude
                </li>
              </ul>
            </div>
            <PrimaryButton type="button" className="w-full sm:w-auto" disabled={!canPay} onClick={() => onRun(pipeline)}>
              Run Council
            </PrimaryButton>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-display mt-0 mb-1 text-lg">{providerLabel} is not connected.</h3>
              <p className="m-0 text-sm text-muted">
                Connect your API key before running the Council. The numbers above are still the packet those three models
                would read.
              </p>
            </div>
            <Link
              to="/settings"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-sm border border-accent bg-accent px-4 font-semibold text-accent-fg no-underline sm:w-auto"
            >
              Open API Settings
            </Link>
          </div>
        )}
        {message ? <p className="mt-3 mb-0 text-danger">{message}</p> : null}
      </div>

      <div className="mt-4 grid gap-2">
        <CouncilFold title="Evidence ledger" summary={ledgerSummary}>
          <EvidenceCoveragePanel
            compact
            manifest={pipeline.manifest}
            packed={pipeline.pack.packed}
            chunks={pipeline.chunks}
          />
        </CouncilFold>
        <CouncilFold
          title="Selected sources"
          summary={`${task.selectedChatSourceIds.length} chats · ${selectedFiles} files`}
        >
          <div className="grid gap-4">
            <SourcePicker
              projectId={project.id}
              chats={chatSources}
              messages={historyMessages}
              selected={task.selectedChatSourceIds}
              onChange={(ids) => patchTask(task.id, { selectedChatSourceIds: ids })}
            />
            <FilePicker
              projectId={project.id}
              files={projectFiles ?? []}
              selected={task.selectedFileIds ?? []}
              onChange={(ids) => patchTask(task.id, { selectedFileIds: ids })}
            />
          </div>
        </CouncilFold>
        <CouncilFold title="Frozen project context" summary={`${frozen.length} items`}>
          {frozen.length === 0 ? (
            <p className="m-0 text-sm text-muted">No invariants, decisions, or specs in this project.</p>
          ) : (
            <ul className="m-0 grid max-h-log list-none gap-2 overflow-auto p-0">
              {frozen.map((item) => (
                <li key={item.id} className="rounded-md bg-bg px-3 py-3 text-sm">
                  <span className="mr-2 text-xs tracking-wider text-faint uppercase">{item.kind}</span>
                  <span className="break-words text-fg">{item.content}</span>
                </li>
              ))}
            </ul>
          )}
        </CouncilFold>
      </div>
    </Panel>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-md bg-subtle p-3">
      <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
      <dd className={`font-display m-0 truncate text-lg tabular-nums ${warn ? "text-warn" : ""}`}>{value}</dd>
    </div>
  );
}
