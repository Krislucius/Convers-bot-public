import { CouncilFold } from "@/components/council-fold";
import { Panel, StatusPill } from "@/components/council-ui";
import { CollapsibleText } from "@/components/collapsible-text";
import { buildManifestPayload, manifestCounts } from "@/lib/council/manifest";
import type { Artifact, ContextItem, ContextManifest, Project, ProjectFile, Task } from "@/lib/council/types";
import { PROVIDER_LABEL, formatChars, formatTokens } from "@/lib/history/format";
import type { ChatSource, HistoryMessage } from "@/lib/history/types";

export function ContextManifestPanel({
  project,
  task,
  context,
  chatSources,
  historyMessages,
  artifacts,
  persisted,
  projectFiles,
}: {
  project: Project;
  task: Task;
  context: ContextItem[];
  chatSources: ChatSource[];
  historyMessages: HistoryMessage[];
  artifacts: Artifact[];
  persisted?: ContextManifest | null;
  projectFiles?: ProjectFile[];
}) {
  const payload = persisted?.payload ?? buildManifestPayload({
    project,
    task,
    context,
    chatSources,
    historyMessages,
    artifacts,
    projectFiles,
  });
  const counts = manifestCounts(payload);
  const coverage = payload.evidence?.coverageStatus ?? "n/a";
  const summary = `${payload.task.mode} · ${counts.chats} chats · ${payload.selectedFiles.length} files · ${coverage} · ${payload.evidence?.audit?.chunksProcessed ?? 0} chunks · ${payload.evidence?.evidenceCount ?? 0} claims · ${payload.evidence?.audit?.packedEvidence ?? 0} packed`;

  return (
    <div className="my-4">
      <CouncilFold title="Context manifest" summary={summary}>
        <dl className="m-0 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Stat label="Project" value={payload.project.name} />
          <Stat label="Task" value={payload.task.title} />
          <Stat label="Task mode" value={payload.task.mode} />
          <Stat label="AI chats" value={String(counts.chats)} />
          <Stat label="Messages" value={String(counts.messages)} />
          <Stat label="Raw characters" value={formatChars(counts.chars)} />
          <Stat label="Estimated tokens" value={formatTokens(counts.tokens)} />
          <Stat label="Selected files" value={String(payload.selectedFiles.length)} />
          <Stat label="Frozen invariants" value={String(counts.frozenInvariants)} />
          <Stat label="Active decisions" value={String(counts.activeDecisions)} />
          <Stat label="Specifications" value={String(counts.specifications)} />
          <Stat label="Project state" value={String(counts.projectState)} />
          <Stat label="Coverage" value={coverage} />
          <Stat label="Chunks processed" value={String(payload.evidence?.audit?.chunksProcessed ?? 0)} />
          <Stat label="Packed evidence" value={String(payload.evidence?.audit?.packedEvidence ?? 0)} />
          <Stat label="Omitted evidence" value={String(payload.evidence?.audit?.omittedEvidence ?? 0)} />
          <Stat label="Ledger claims" value={String(payload.evidence?.evidenceCount ?? 0)} />
        </dl>
        {payload.evidence ? (
          <p className="mt-3 mb-0 text-sm text-muted">{payload.evidence.coverageMeaning}</p>
        ) : null}
        {payload.evidence ? (
          <p className="mt-3 mb-0 font-mono text-xs break-all text-faint">
            Extractor {payload.evidence.extractorFingerprint} · ledger {payload.evidence.ledgerHash} · context{" "}
            {payload.evidence.contextHash}
          </p>
        ) : null}
        {persisted ? (
          <p className="mt-3 mb-0 font-mono text-xs break-all text-faint">
            Snapshot {persisted.id.slice(0, 8)} · hash {persisted.hash}
          </p>
        ) : (
          <p className="mt-3 mb-0 text-sm text-muted">Inspect this packet before Run Council. It is persisted at execution.</p>
        )}
        <ul className="mt-4 mb-0 grid max-h-log list-none gap-2 overflow-auto p-0">
          {payload.selectedAiChats.length === 0 ? (
            <li className="text-sm text-muted">No AI chats in this snapshot.</li>
          ) : (
            payload.selectedAiChats.map((chat) => (
              <li key={chat.source_id} className="rounded-md bg-bg px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="break-words text-fg">{chat.title}</strong>
                  <span className="text-faint">{PROVIDER_LABEL[chat.provider as keyof typeof PROVIDER_LABEL] ?? chat.provider}</span>
                  <StatusPill status={chat.import_status} />
                  <StatusPill status={chat.access_status} />
                </div>
                <p className="m-0 mt-1 text-xs break-all text-faint tabular-nums">
                  {chat.source_id} · {chat.message_count ?? 0} messages · {formatChars(chat.character_count)} · ~
                  {formatTokens(chat.estimated_tokens ?? Math.ceil(chat.character_count / 4))} · local{" "}
                  {chat.content_available_locally ? "yes" : "no"}
                </p>
              </li>
            ))
          )}
        </ul>
        <div className="mt-4 grid gap-4 text-sm">
          <ManifestList title="Frozen invariants" rows={payload.frozenInvariants} />
          <ManifestList title="Active decisions" rows={payload.activeDecisions} />
          <ManifestList title="Active specifications" rows={payload.activeSpecifications} />
          <ManifestList title="Project state" rows={payload.projectState} />
          <ManifestList
            title="Selected files"
            rows={payload.selectedFiles.map((file) => ({
              id: file.file_id,
              content: `${file.filename} · ${file.kind} · ${formatChars(file.character_count)}`,
            }))}
          />
        </div>
        {payload.candidateArtifact ? (
          <p className="mt-3 mb-0 text-sm text-muted">
            Candidate: {payload.candidateArtifact.title} v{payload.candidateArtifact.version} ({payload.candidateArtifact.status})
          </p>
        ) : null}
      </CouncilFold>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md bg-bg p-3">
      <dt className="text-xs tracking-wider text-faint uppercase">{label}</dt>
      <dd className="font-display m-0 truncate text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function ManifestList({ title, rows }: { title: string; rows: Array<{ id: string; content: string }> }) {
  return (
    <section>
      <h3 className="mt-0 mb-2 text-xs font-semibold tracking-widest text-muted uppercase">{title}</h3>
      {rows.length === 0 ? (
        <p className="m-0 text-muted">None.</p>
      ) : (
        <ul className="m-0 grid max-h-log list-none gap-2 overflow-auto p-0">
          {rows.map((row) => (
            <li key={row.id} className="rounded-md bg-bg px-3 py-2 break-words text-fg">
              {row.content}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ArtifactPanel({ artifact }: { artifact: Artifact }) {
  return (
    <Panel>
      <p className="mb-1 text-xs font-semibold tracking-widest text-muted uppercase">Created artifact</p>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="font-display m-0 text-xl">{artifact.title}</h2>
        <StatusPill status={artifact.status} />
        <span className="text-xs tracking-wider text-faint uppercase">
          {artifact.type} · v{artifact.version}
        </span>
      </div>
      <p className="mt-0 text-xs break-all text-faint">
        Artifact {artifact.id.slice(0, 8)} · context hash {artifact.contextHash}
      </p>
      <CollapsibleText text={artifact.content} defaultCollapsed />
      {artifact.evidenceLabels.length ? (
        <ul className="mt-4 mb-0 grid max-h-log list-none gap-2 overflow-auto p-0">
          {artifact.evidenceLabels.map((row) => (
            <li key={`${row.claim}-${row.status}`} className="rounded-md bg-subtle px-3 py-2 text-sm">
              <span className="mr-2 text-xs tracking-wider text-faint uppercase">{row.status}</span>
              <span className="break-words text-fg">{row.claim}</span>
              {row.citation ? <span className="ml-2 font-mono text-xs break-all text-faint">{row.citation}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}
