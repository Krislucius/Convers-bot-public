import { useState } from "react";
import { ArtifactPanel } from "@/components/context-manifest-panel";
import { ImplementationPacketPanel } from "@/components/implementation-packet-panel";
import { PresentedText } from "@/components/presented-text";
import { StatusPill } from "@/components/council-ui";
import { isSynthesisResponse, responseMemberId } from "@/lib/council/agents";
import type { DecisionRecord } from "@/lib/council/decision";
import { renderResultMarkdown, renderTechnicalJson } from "@/lib/council/export-result";
import type { CouncilMember } from "@/lib/council/members";
import { memberLabel } from "@/lib/council/members";
import { providerName } from "@/lib/council/providers";
import type { AgentResponse, Artifact, CouncilResult, ImplementationPacket, ProviderId, Task } from "@/lib/council/types";
import { localizeDecisionRecordStatic, type LocalizedNarrative } from "@/lib/i18n/result-localize";
import { useI18n } from "@/lib/i18n/provider";

type Tab = "outcome" | "positions" | "evidence" | "technical";

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Block({ title, rows }: { title: string; rows: string[] }) {
  const { t } = useI18n();
  return (
    <section>
      <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{title}</h3>
      {rows.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {rows.map((row) => (
            <li key={row} className="break-words">
              {row}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t("task.noneRecorded")}</p>
      )}
    </section>
  );
}

export function CouncilResultView({
  task,
  record,
  result,
  responses,
  members,
  narrative,
  artifact,
  packet,
  provider,
  billing,
  sourceManifest,
  priorResponses,
  completed,
  callLimit,
}: {
  task: Task;
  record: DecisionRecord;
  result: CouncilResult | null;
  responses: AgentResponse[];
  members: CouncilMember[];
  narrative: LocalizedNarrative | null;
  artifact: Artifact | null;
  packet: ImplementationPacket | null;
  provider: ProviderId | string;
  billing: string | null;
  sourceManifest: string[];
  priorResponses: AgentResponse[];
  completed: boolean;
  callLimit: number;
}) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>("outcome");
  const [forceOpen, setForceOpen] = useState<boolean | null>(null);
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "outcome", label: t("result.outcome") },
    { id: "positions", label: t("result.positions") },
    { id: "evidence", label: t("result.evidence") },
    { id: "technical", label: t("result.technical") },
  ];
  const localized = locale === "ru" ? localizeDecisionRecordStatic(record, "ru") : null;
  const exportInput = {
    locale,
    task,
    provider,
    members,
    record,
    result,
    responses,
    artifact,
    narrative,
    localizedRecord: localized
      ? {
          summary: narrative?.decision || localized.summary,
          why: narrative?.rationale || localized.why,
          completed: localized.completed,
          notCompleted: localized.notCompleted,
          blockerNotes: localized.blockerNotes,
          recommendations: localized.recommendations,
          required: localized.required,
          userActions: localized.userActions,
          nextActionWhy: localized.nextActionWhy,
        }
      : null,
    sourceManifest,
  };

  function onDownload() {
    downloadText("council-result.md", renderResultMarkdown(exportInput), "text/markdown;charset=utf-8");
  }
  function onDownloadJson() {
    downloadText("council-technical.json", renderTechnicalJson(exportInput), "application/json");
  }

  return (
    <section className="mt-6 grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="min-h-11 rounded-sm border border-line px-3 font-semibold" onClick={() => setForceOpen(true)}>
          {t("result.expandAll")}
        </button>
        <button type="button" className="min-h-11 rounded-sm border border-line px-3 font-semibold" onClick={() => setForceOpen(false)}>
          {t("result.collapseAll")}
        </button>
        {completed ? (
          <>
            <button type="button" className="min-h-11 rounded-sm border border-accent bg-accent px-3 font-semibold text-accent-fg" onClick={onDownload}>
              {t("result.download")}
            </button>
            <button type="button" className="min-h-11 rounded-sm border border-line px-3 font-semibold" onClick={onDownloadJson}>
              {t("result.downloadJson")}
            </button>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2" role="tablist">
        {tabs.map((row) => (
          <button
            key={row.id}
            type="button"
            role="tab"
            aria-selected={tab === row.id}
            className={`min-h-11 rounded-sm px-3 font-semibold ${tab === row.id ? "border border-accent bg-accent text-accent-fg" : "border border-line"}`}
            onClick={() => setTab(row.id)}
          >
            {row.label}
          </button>
        ))}
      </div>

      {tab === "outcome" && result ? (
        <div>
          {result.decision ? (
            <>
              <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("record.outcome")}</h3>
              <PresentedText original={result.decision} localized={narrative?.decision} forceOpen={forceOpen} />
              {result.rationale ? (
                <>
                  <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{t("record.why")}</h3>
                  <PresentedText original={result.rationale} localized={narrative?.rationale} forceOpen={forceOpen} />
                </>
              ) : null}
              <Block title={t("fold.alternatives")} rows={narrative?.alternatives ?? result.alternatives} />
              <Block title={t("fold.dissent")} rows={narrative?.dissent ?? result.dissent} />
              <Block title={t("fold.risks")} rows={narrative?.risks ?? result.risks} />
            </>
          ) : null}
          <h3 className="mt-4 text-sm font-semibold tracking-widest text-muted uppercase">{t("record.recommendations")}</h3>
          <PresentedText original={result.recommendation || "—"} localized={narrative?.recommendation} forceOpen={forceOpen} />
          <Block title={t("fold.disagreements")} rows={narrative?.disagreements ?? result.disagreements} />
          <Block title={t("fold.issues")} rows={narrative?.issues ?? result.issues} />
          <Block title={t("fold.corrections")} rows={narrative?.proposedCorrections ?? result.proposedCorrections} />
          <Block title={t("fold.resolvedIssues")} rows={narrative?.resolvedIssues ?? result.resolvedIssues} />
          <Block title={t("fold.openFollowups")} rows={narrative?.unresolvedIssues ?? result.unresolvedIssues} />
        </div>
      ) : null}

      {tab === "positions" ? (
        <div className="grid gap-6">
          <section>
            <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("result.round1")}</h3>
            {members.map((member) => {
              const row = responses.find(
                (item) => responseMemberId(item) === member.memberId && (item.stage === "ROUND_1" || item.round === 1) && !isSynthesisResponse(item),
              );
              return (
                <div key={`r1-${member.memberId}`} className="mt-3">
                  <p className="m-0 text-xs tracking-wider text-faint uppercase">{memberLabel(member)}</p>
                  {row?.error ? (
                    <p className="text-danger">{narrative?.errors?.[`${member.memberId}:${row.stage ?? row.round}`] ?? row.error}</p>
                  ) : (
                    <PresentedText original={row?.responseText || t("task.noneRecorded")} localized={narrative?.round1?.[member.memberId]} defaultCollapsed forceOpen={forceOpen} />
                  )}
                </div>
              );
            })}
          </section>
          <section>
            <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("result.round2")}</h3>
            {members.map((member) => {
              const row = responses.find(
                (item) => responseMemberId(item) === member.memberId && (item.stage === "ROUND_2" || item.round === 2) && !isSynthesisResponse(item),
              );
              return (
                <div key={`r2-${member.memberId}`} className="mt-3">
                  <p className="m-0 text-xs tracking-wider text-faint uppercase">{memberLabel(member)}</p>
                  {row?.error ? (
                    <p className="text-danger">{narrative?.errors?.[`${member.memberId}:${row.stage ?? row.round}`] ?? row.error}</p>
                  ) : (
                    <PresentedText original={row?.responseText || t("task.noneRecorded")} localized={narrative?.round2?.[member.memberId]} defaultCollapsed forceOpen={forceOpen} />
                  )}
                </div>
              );
            })}
          </section>
          <section>
            <h3 className="mt-0 text-sm font-semibold tracking-widest text-muted uppercase">{t("result.synthesis")}</h3>
            <PresentedText
              original={responses.find((row) => isSynthesisResponse(row))?.responseText || result?.synthesisRaw || t("task.noneRecorded")}
              localized={narrative?.synthesis}
              defaultCollapsed
              forceOpen={forceOpen}
            />
          </section>
        </div>
      ) : null}

      {tab === "evidence" ? (
        <div className="grid gap-4">
          <Block title={t("fold.citations")} rows={result?.citations ?? []} />
          {result?.evidence.length ? (
            <ul className="m-0 grid list-none gap-2 p-0">
              {result.evidence.map((row) => (
                <li key={row.claim} className="break-words">
                  <StatusPill status={row.status} /> {row.claim}{" "}
                  <span className="font-mono text-xs break-all text-faint">{row.citation ?? "no citation"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {sourceManifest.length ? <Block title={t("fold.repository")} rows={sourceManifest} /> : null}
          {artifact ? <ArtifactPanel artifact={artifact} /> : null}
          {packet ? <ImplementationPacketPanel packet={packet} /> : null}
        </div>
      ) : null}

      {tab === "technical" ? (
        <div>
          <p className="mt-0 mb-3 flex flex-wrap gap-3 text-sm text-muted tabular-nums">
            <span>
              {t("run.provider")}: {providerName(provider)}
            </span>
            {billing ? (
              <span>
                {t("run.billing")}: {billing}
              </span>
            ) : null}
            <span>
              {t("run.calls")}: {task.diagnostics?.run?.requestBudget?.used ?? responses.length} / {task.diagnostics?.run?.requestBudget?.limit ?? callLimit}
            </span>
          </p>
          <pre className="m-0 font-mono text-sm whitespace-pre-wrap break-all text-muted">
            {responses
              .map(
                (row) =>
                  `${responseMemberId(row)} ${row.role} ${row.stage} attempt ${row.attempt ?? "—"} · ${row.model} · in=${row.inputTokens ?? "—"} out=${row.outputTokens ?? "—"}`,
              )
              .join("\n") || t("task.noneRecorded")}
          </pre>
          {priorResponses.length ? (
            <pre className="mt-4 font-mono text-sm whitespace-pre-wrap break-all text-muted">
              {priorResponses
                .map((row) => `${row.runId?.slice(0, 8) ?? "legacy"} · ${responseMemberId(row)} ${row.stage} · ${row.error ? "failed" : "kept"}`)
                .join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
