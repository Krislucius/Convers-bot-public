import { Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { SourcePicker } from "@/components/source-picker";
import { EvidenceCoveragePanel } from "@/components/evidence-coverage";
import { Panel, PrimaryButton } from "@/components/council-ui";
import { CONTEXT_TOKEN_LIMIT, estimateCouncilRun } from "@/lib/council/protocol";
import { patchTask } from "@/lib/council/store";
import { councilPreflight } from "@/lib/council/task-mode";
import type { Artifact, ContextItem, Project, ProjectFile, Task } from "@/lib/council/types";
import { coverageBlocksCouncil, runEvidencePipeline } from "@/lib/evidence/pipeline";
import { formatChars, formatTokens, formatUsd } from "@/lib/history/format";
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
  onRun: () => void;
  projectFiles?: ProjectFile[];
}) {
  const candidate = artifacts.find((row) => row.id === task.candidateArtifactId) ?? null;
  const pipeline = runEvidencePipeline({
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
  const budgetError = pipeline.pack.ok ? null : "Mandatory context exceeds the Council budget.";
  const canPay = ready && precheck.ok && !busy && !coverageError && !budgetError;

  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Council run</p>
      <h2 className="font-display mt-0 mb-4 text-xl">What GPT, Grok, and Claude will read</h2>
      <p className="mt-0 mb-4 text-sm text-muted">
        Mode <span className="text-fg">{task.mode}</span>
        {task.requiresHistoricalContext ? " · historical context required" : ""}
      </p>

      <dl className="m-0 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md bg-subtle p-4">
          <dt className="text-xs tracking-wider text-faint uppercase">Selected chats</dt>
          <dd className="font-display m-0 text-2xl tabular-nums">{task.selectedChatSourceIds.length}</dd>
        </div>
        <div className="rounded-md bg-subtle p-4">
          <dt className="text-xs tracking-wider text-faint uppercase">Selected files</dt>
          <dd className="font-display m-0 text-2xl tabular-nums">{(task.selectedFileIds ?? []).length}</dd>
        </div>
        <div className="rounded-md bg-subtle p-4">
          <dt className="text-xs tracking-wider text-faint uppercase">Estimated input context</dt>
          <dd className="font-display m-0 text-2xl tabular-nums">{formatTokens(estimate.inputTokens)}</dd>
        </div>
        <div className="rounded-md bg-subtle p-4">
          <dt className="text-xs tracking-wider text-faint uppercase">Estimated Council cost</dt>
          <dd className={`font-display m-0 text-2xl tabular-nums ${estimate.overBudget ? "text-warn" : ""}`}>
            {formatUsd(estimate.costUsd)}
          </dd>
        </div>
      </dl>

      {pipeline.pack.omitted.length > 0 ? (
        <p className="mt-3 mb-0 text-sm text-warn">
          Packed {pipeline.pack.packed.length} claims ({formatChars(estimate.inputChars)} / {formatTokens(CONTEXT_TOKEN_LIMIT)}).
          Omitted {pipeline.pack.omitted.length} ranked claims after every selected source was extracted.
        </p>
      ) : null}

      {estimate.overBudget ? (
        <p className="mt-3 mb-0 text-sm text-warn">
          Estimated cost exceeds the {formatUsd(budget)} limit in API Settings. Council will stop if the limit is reached.
        </p>
      ) : null}

      {task.mode === "REVIEW" && candidate ? (
        <p className="mt-4 mb-0 text-sm text-muted">
          Candidate artifact: <span className="text-fg">{candidate.title}</span> v{candidate.version}
        </p>
      ) : null}

      <h3 className="mt-6 mb-2 text-sm font-semibold tracking-widest text-muted uppercase">Frozen project context</h3>
      {frozen.length === 0 ? (
        <p className="mt-0 text-sm text-muted">No invariants, decisions, or specs in this project.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {frozen.map((item) => (
            <li key={item.id} className="rounded-md bg-subtle px-3 py-3 text-sm">
              <span className="mr-2 text-xs tracking-wider text-faint uppercase">{item.kind}</span>
              <span className="text-fg">{item.content.length > 140 ? `${item.content.slice(0, 140)}…` : item.content}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <EvidenceCoveragePanel manifest={pipeline.manifest} packed={pipeline.pack.packed} chunks={pipeline.chunks} />
      </div>

      <div className="mt-6">
        <SourcePicker
          projectId={project.id}
          chats={chatSources}
          messages={historyMessages}
          selected={task.selectedChatSourceIds}
          onChange={(ids) => patchTask(task.id, { selectedChatSourceIds: ids })}
        />
      </div>

      {!precheck.ok ? (
        <p className="mt-4 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">
          {precheck.error}
        </p>
      ) : null}
      {coverageError ? (
        <p className="mt-4 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{coverageError}</p>
      ) : null}
      {budgetError ? (
        <p className="mt-4 mb-0 rounded-md border border-danger bg-subtle px-3 py-3 text-sm text-danger">{budgetError}</p>
      ) : null}

      {ready ? (
        <div className="mt-6">
          <p className="mt-0 mb-2 text-ok">Council Ready</p>
          <ul className="mb-4 flex list-none flex-wrap gap-4 p-0 text-sm">
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
          <PrimaryButton type="button" disabled={!canPay} onClick={onRun}>
            Run Council
          </PrimaryButton>
        </div>
      ) : (
        <div className="mt-6">
          <h3 className="font-display mt-0 mb-2 text-xl">{providerLabel} is not connected.</h3>
          <p className="text-muted">
            Connect your API key before running the Council. The numbers above are still the packet those three models would
            read.
          </p>
          <Link
            to="/settings"
            className="inline-flex min-h-11 items-center rounded-sm border border-accent bg-accent px-4 font-semibold text-accent-fg no-underline"
          >
            Open API Settings
          </Link>
        </div>
      )}
      {message ? <p className="mt-3 text-danger">{message}</p> : null}
    </Panel>
  );
}
