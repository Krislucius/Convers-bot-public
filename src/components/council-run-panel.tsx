import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { CouncilFold } from "@/components/council-fold";
import { SourcePicker } from "@/components/source-picker";
import { FilePicker } from "@/components/file-picker";
import { EvidenceCoveragePanel } from "@/components/evidence-coverage";
import { Panel, PrimaryButton, StatusPill } from "@/components/council-ui";
import { CONTEXT_TOKEN_LIMIT, estimateCouncilRun } from "@/lib/council/protocol";
import { attemptLimit, expectedSuccessfulCalls, memberLabel, type CouncilMember } from "@/lib/council/members";
import { PROVIDER_IDS, PROVIDERS, providerName } from "@/lib/council/providers";
import { patchTask } from "@/lib/council/store";
import { councilPreflight } from "@/lib/council/task-mode";
import type { Artifact, ContextItem, Project, ProjectFile, ProviderId, Task } from "@/lib/council/types";
import { coverageBlocksCouncil } from "@/lib/evidence/pipeline";
import { cachedEvidencePipeline, type EvidencePipelineResult } from "@/lib/evidence/pipeline-cache";
import { ledgerFoldLabelFromManifest } from "@/lib/evidence/preview";
import { formatTokens, formatUsd } from "@/lib/history/format";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export function CouncilRunMeter({
  provider,
  used,
  limit,
  costUsd,
}: {
  provider: string;
  used: number;
  limit: number;
  costUsd?: number | null;
}) {
  return (
    <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
      <span>
        Provider: <span className="text-fg">{provider}</span>
      </span>
      <span>
        Calls: <span className="text-fg">{used} / {limit}</span>
      </span>
      <span>Cost: {costUsd != null ? `${formatUsd(costUsd)} (telemetry)` : "telemetry only"}</span>
    </p>
  );
}

export function CouncilRunPanel({
  project,
  task,
  frozen,
  chatSources,
  historyMessages,
  artifacts,
  maxCostUsd,
  ready,
  provider,
  providerLabel,
  members,
  busy,
  message,
  onRun,
  onProviderChange,
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
  provider: ProviderId;
  providerLabel: string;
  members: CouncilMember[];
  busy: boolean;
  message: string;
  onRun: (pipeline: EvidencePipelineResult) => void;
  onProviderChange?: (provider: ProviderId) => void;
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
  const memberCount = members.length || 3;
  const expected = expectedSuccessfulCalls(memberCount);
  const limit = attemptLimit(memberCount);
  const estimate = estimateCouncilRun(ctx, maxCostUsd, memberCount);
  const precheck = councilPreflight({ task, artifacts });
  const coverageError = coverageBlocksCouncil(pipeline.coverage);
  const budgetError = pipeline.pack.ok ? null : "Mandatory context exceeds the Council token budget.";
  const selectionError = members.length < 2 ? "Select at least 2 Council models in API Settings." : null;
  const canPay = ready && precheck.ok && !busy && !coverageError && !budgetError && !selectionError;
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

      <fieldset className="mb-4 grid gap-2">
        <legend className="text-sm font-medium text-muted">API Provider</legend>
        <div className="flex flex-wrap gap-2">
          {PROVIDER_IDS.map((id) => {
            const selected = id === provider;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onProviderChange?.(id)}
                className={`min-h-11 rounded-sm px-3.5 py-2.5 font-semibold ${
                  selected
                    ? "border border-accent bg-accent text-accent-fg"
                    : "border border-line bg-transparent text-fg"
                }`}
              >
                {PROVIDERS[id].name}
              </button>
            );
          })}
        </div>
      </fieldset>

      <CouncilRunMeter provider={providerName(provider)} used={0} limit={limit} costUsd={estimate.costUsd} />

      <dl className="m-0 mt-4 grid grid-cols-3 gap-2 lg:grid-cols-5">
        <Stat label="Mode" value={task.mode} />
        <Stat label="Selected chats" value={String(task.selectedChatSourceIds.length)} />
        <Stat label="Selected files" value={String(selectedFiles)} />
        <Stat label="Estimated context" value={formatTokens(estimate.inputTokens)} />
        <Stat label="Expected calls" value={`${expected} / ${limit}`} />
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

      <p className="mt-3 mb-0 text-sm text-muted">
        Cost is telemetry only. Council stops at {limit} provider attempts, not at a USD cap.
      </p>

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
      {selectionError ? (
        <p className="mt-3 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{selectionError}</p>
      ) : null}

      <div className="sticky top-0 z-10 mt-4 border-y border-line bg-elevated py-3">
        {ready ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 text-ok">Council Ready</p>
              <ul className="m-0 flex list-none flex-wrap gap-3 p-0 text-sm">
                {members.map((row) => (
                  <li key={row.modelId} className="inline-flex items-center gap-1.5">
                    <Check className="size-4 text-ok" aria-hidden="true" /> {memberLabel(row)}
                  </li>
                ))}
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
                Connect your API key and select Council models before running. The numbers above are still the packet
                those models would read.
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
