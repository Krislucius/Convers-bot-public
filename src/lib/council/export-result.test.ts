import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { DecisionRecord } from "./decision.ts";
import { renderResultMarkdown, renderTechnicalJson, type ResultExportInput } from "./export-result.ts";
import type { CouncilMember } from "./members.ts";

const members: CouncilMember[] = [
  { memberId: "m1", role: "LEAD_REASONER", modelId: "kimi", label: "Kimi", family: "other" },
  { memberId: "m2", role: "ADVERSARIAL", modelId: "qwen", label: "Qwen", family: "other" },
];

const record: DecisionRecord = {
  runStatus: "COMPLETE",
  verdict: "READY_FOR_REVIEW",
  summary: "English summary of the council.",
  conclusion: "English summary of the council.",
  why: "English why.",
  completed: ["Implemented the ledger."],
  notCompleted: ["Did not freeze the artifact."],
  agreed: [],
  implementationState: [],
  blockers: [],
  resolved: [],
  recommendations: ["Review the patch."],
  required: ["Attach the repository."],
  userActions: ["Upload the zip."],
  userDecisions: [],
  implementationNotes: [],
  blockerNotes: ["Missing repository snapshot."],
  nextAction: "CREATE_PATCH",
  nextActionWhy: "Council asked for a patch.",
};

function input(locale: "en" | "ru"): ResultExportInput {
  return {
    locale,
    task: {
      title: "Contract review",
      originalTitle: "Проверка договора",
      originalTask: "Проверь договор.",
      prompt: "Review the contract.",
      canonicalTaskEn: "Review the contract.",
      mode: "REVIEW",
    },
    provider: "nanogpt",
    members,
    record,
    result: {
      taskId: "t1",
      status: "READY_FOR_REVIEW",
      recommendation: "English recommendation",
      synthesisRaw: "English synthesis",
      disagreements: ["Price clause"],
      issues: [],
      proposedCorrections: [],
      resolvedIssues: ["Clock split"],
      unresolvedIssues: ["Repository"],
      citations: ["file:contract.pdf#1"],
      evidence: [],
      alternatives: [],
      dissent: [],
      risks: [],
      failedAgents: [],
    },
    responses: [
      {
        memberId: "m1",
        role: "LEAD_REASONER",
        stage: "ROUND_1",
        round: 1,
        responseText: "English round one.",
        model: "kimi",
      },
      {
        memberId: "m1",
        role: "LEAD_REASONER",
        stage: "ROUND_2",
        round: 2,
        responseText: "English round two.",
        model: "kimi",
      },
      {
        memberId: "m1",
        role: "LEAD_REASONER",
        stage: "SYNTHESIS",
        round: 3,
        responseText: "English synthesis body.",
        model: "kimi",
      },
    ],
    artifact: {
      id: "a1",
      projectId: "p1",
      taskId: "t1",
      type: "SPEC",
      title: "Candidate",
      version: "1",
      content: "Artifact body stays in the download.",
      status: "DRAFT",
      contextHash: "h",
      evidenceLabels: [],
      createdAt: "2026-09-23T00:00:00.000Z",
    },
    narrative:
      locale === "ru"
        ? {
            recommendation: "Русская рекомендация",
            synthesis: "Русский синтез",
            decision: "Русский итог",
            rationale: "Русское обоснование",
            disagreements: ["Оговорка о цене"],
            issues: [],
            proposedCorrections: [],
            resolvedIssues: ["Разделение часов закрыто"],
            unresolvedIssues: ["Нет репозитория"],
            alternatives: [],
            dissent: [],
            risks: [],
            positions: {},
            round1: { m1: "Русский раунд 1" },
            round2: { m1: "Русский раунд 2" },
            errors: {},
            sourceHash: "h",
          }
        : null,
    sourceManifest: ["contract.pdf SOURCE_STATUS=EXTRACTED"],
  } as unknown as ResultExportInput;
}

describe("result export", () => {
  it("downloads Russian markdown from persisted text and keeps technical JSON in English", () => {
    const ru = renderResultMarkdown(input("ru"));
    const en = renderResultMarkdown(input("en"));
    const json = JSON.parse(renderTechnicalJson(input("ru"))) as { language: string; responses: Array<{ responseText: string }>; citations: string[]; artifact: { content: string } };
    assert.equal(typeof ru, "string");
    assert.match(ru, /Запись решения/);
    assert.match(ru, /Русский раунд 1/);
    assert.match(ru, /Русский синтез/);
    assert.match(ru, /Оговорка о цене/);
    assert.match(ru, /SOURCE_STATUS=EXTRACTED/);
    assert.match(ru, /Artifact body stays in the download/);
    assert.match(ru, /file:contract\.pdf#1/);
    assert.doesNotMatch(ru, /English round one/);
    assert.match(en, /Decision record/);
    assert.match(en, /English round one/);
    assert.equal(json.language, "en");
    assert.equal(json.responses.some((row) => row.responseText === "English round one."), true);
    assert.deepEqual(json.citations, ["file:contract.pdf#1"]);
    assert.match(json.artifact.content, /Artifact body/);
    assert.equal(JSON.stringify(json).includes("Русский раунд"), false);
  });

  it("does not rerun Council when the language or export changes", () => {
    const page = readFileSync(fileURLToPath(new URL("../../routes/t.$taskId.tsx", import.meta.url)), "utf8");
    const effect = page.slice(page.indexOf('locale !== "ru"'), page.indexOf("}, [taskId, locale"));
    assert.equal(effect.includes("startCouncilRun"), false);
    assert.equal(effect.includes("localizeTaskResult"), true);
    assert.equal(page.includes("onProviderChange={setProvider}"), false);
    assert.match(page, /patchTask\(currentTask\.id, \{ provider: id \}\)/);
    const view = readFileSync(fileURLToPath(new URL("../../components/council-result-view.tsx", import.meta.url)), "utf8");
    assert.equal(view.includes("overflow-auto"), false);
    assert.equal(view.includes("max-h-log"), false);
    assert.match(view, /result\.expandAll/);
    assert.match(view, /result\.download/);
    const fold = readFileSync(fileURLToPath(new URL("../../components/collapsible-text.tsx", import.meta.url)), "utf8");
    assert.equal(fold.includes("max-h-log overflow-auto"), false);
    const packet = readFileSync(fileURLToPath(new URL("../evidence/common-packet.ts", import.meta.url)), "utf8");
    assert.equal(packet.includes("provider:"), false);
    const pipeline = readFileSync(fileURLToPath(new URL("../evidence/pipeline.ts", import.meta.url)), "utf8");
    assert.equal(pipeline.split("buildCommonEvidencePacket(").length - 1, 1);
  });
});
