import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyGate, completeOutput, createSynthesisPrompt, decideSynthesisPrompt, parseJson, reviewSynthesisPrompt } from "./protocol.ts";
import { deriveDecisionRecord } from "./decision.ts";
import { acceptSynthesisJson, inspectSynthesis } from "./json-schema.ts";
import { operatorRecordJson, parseOperatorRecord, SAMPLE_OPERATOR_RECORD } from "./operator-record.ts";
import { localizeDecisionRecord, localizeDecisionRecordStatic } from "../i18n/result-localize.ts";
import { t } from "../i18n/catalog.ts";
import type { AgentResponse, Task } from "./types.ts";
import type { TranslateFn } from "../i18n/translate.ts";

const task: Task = {
  id: "t-op",
  projectId: "p1",
  title: "Spec",
  prompt: "Write the spec",
  status: "CREATED",
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
  totalInputTokens: null,
  totalOutputTokens: null,
  totalCostUsd: null,
  totalLatencyMs: null,
  diagnostics: null,
  selectedChatSourceIds: [],
  selectedFileIds: [],
  mode: "DECIDE",
  requiresHistoricalContext: false,
  candidateArtifactId: null,
  decisionQuestion: "Which clock stays?",
  contextManifestId: null,
  contextHash: null,
  provider: null,
};

describe("operator_record", () => {
  it("parses snake_case JSON into a Decision Record payload", () => {
    const parsed = parseOperatorRecord({
      summary: "Keep the matching clock.",
      completed: ["Council agreed on the clock split."],
      not_completed: ["none"],
      implementation: ["No repository attached."],
      blockers: [],
      recommended: ["Run REVIEW."],
      required: ["none"],
      user_actions: ["Confirm the clock owner."],
      next_step: "Run REVIEW on the candidate.",
    });
    assert.ok(parsed);
    assert.equal(parsed.summary, "Keep the matching clock.");
    assert.deepEqual(parsed.completed, ["Council agreed on the clock split."]);
    assert.deepEqual(parsed.notCompleted, []);
    assert.deepEqual(parsed.required, []);
    assert.equal(parsed.nextStep, "Run REVIEW on the candidate.");
    assert.equal(parseOperatorRecord({ summary: "  " }), null);
  });

  it("synthesis prompts ask for a human operator_record inside JSON only", () => {
    for (const prompt of [createSynthesisPrompt(["lead"]), reviewSynthesisPrompt(["lead"]), decideSynthesisPrompt(["lead"])]) {
      assert.match(prompt, /operator_record/);
      assert.match(prompt, /human-readable/);
      assert.match(prompt, /JSON object only/);
      assert.equal(/markdown artifact outside|reply with markdown/i.test(prompt), false);
    }
  });

  it("drives Decision Record sections from operator_record and keeps ledger P0 authoritative", () => {
    const parsed = parseJson(
      JSON.stringify({
        status: "APPROVED",
        consensus: ["machine consensus should be replaced"],
        disagreements: [],
        blockers: [],
        recommendation: "machine recommendation",
        agent_positions: { gpt: "ok" },
        decision: "keep",
        rationale: "ok",
        dissent: [],
        operator_record: operatorRecordJson({
          summary: "Clocks stay distinct. Candidate is ready for REVIEW.",
          completed: ["Reconstructed the clock-split specification."],
          not_completed: ["REVIEW has not run."],
          implementation: ["No repository snapshot is attached."],
          blockers: [],
          recommended: ["Attach the repo, then run REVIEW."],
          required: [],
          user_actions: [],
          next_step: "Run REVIEW against the candidate.",
        }),
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.operatorRecord?.summary, "Clocks stay distinct. Candidate is ready for REVIEW.");
    const gated = applyGate(parsed!, [], "CREATE");
    const createTask = { ...task, mode: "CREATE" as const, id: "t-create" };
    const out = completeOutput(createTask, [], parsed!, gated, {
      artifact: {
        id: "a1",
        projectId: "p1",
        taskId: "t-create",
        type: "SPECIFICATION",
        title: "Spec",
        version: "1.0",
        content: "# Spec",
        status: "READY_FOR_REVIEW",
        contextHash: "h",
        evidenceLabels: [],
        createdAt: task.createdAt,
      },
    });
    const record = deriveDecisionRecord({ mode: "CREATE", runStatus: "COMPLETE", result: out.result });
    assert.equal(record.summary, "Clocks stay distinct. Candidate is ready for REVIEW.");
    assert.deepEqual(record.completed, ["Reconstructed the clock-split specification."]);
    assert.deepEqual(record.notCompleted, ["REVIEW has not run."]);
    assert.deepEqual(record.implementationNotes, ["No repository snapshot is attached."]);
    assert.deepEqual(record.recommendations, ["Attach the repo, then run REVIEW."]);
    assert.equal(record.nextActionWhy, "Run REVIEW against the candidate.");
    assert.equal(record.nextAction, "RUN_REVIEW");
    assert.equal(record.blockers.length, 0);

    const dump = "The candidate violates the frozen clock split invariant.";
    const blocked = parseJson(
      JSON.stringify({
        status: "APPROVED",
        consensus: ["ok"],
        disagreements: [],
        blockers: [],
        recommendation: "go",
        agent_positions: { gpt: "ok" },
        unresolved_issues: ["clock split invariant break"],
        operator_record: operatorRecordJson({
          summary: "Cannot accept: clock split is still open.",
          blockers: ["Human note must not replace the P0 card."],
          next_step: "Fix the P0, then re-run CREATE.",
        }),
      }),
    );
    assert.ok(blocked);
    const blockedGate = applyGate(
      blocked!,
      [
        {
          agent: "gpt",
          memberId: "gpt",
          round: 2,
          stage: "ROUND_2",
          structured: { P0_BLOCKERS: dump, REMAINING_P0: "clock split invariant break" },
          responseText: "ok",
          error: null,
        } as unknown as AgentResponse,
      ],
      "CREATE",
    );
    const blockedOut = completeOutput(createTask, [], blocked!, blockedGate);
    const blockedRecord = deriveDecisionRecord({
      mode: "CREATE",
      runStatus: "COMPLETE",
      result: blockedOut.result,
    });
    assert.equal(blockedRecord.verdict, "BLOCKED");
    assert.equal(blockedRecord.blockers.length >= 1, true);
    assert.equal(blockedRecord.blockers[0]?.severity, "P0");
    assert.ok(blockedRecord.blockers[0]?.issueId.startsWith("iss_"));
    assert.deepEqual(blockedRecord.blockerNotes, ["Human note must not replace the P0 card."]);
    assert.equal(blockedRecord.summary, "Cannot accept: clock split is still open.");
  });

  it("inspects synthesis as invalid without operator_record.summary", () => {
    const issues = acceptSynthesisJson({ status: "APPROVED", recommendation: "go" }, "DECIDE");
    assert.ok(issues.some((row) => row.path === "/operator_record"));
    const ok = inspectSynthesis(
      JSON.stringify({
        status: "APPROVED",
        recommendation: "go",
        operator_record: operatorRecordJson(),
      }),
      "DECIDE",
    );
    assert.equal(ok.ok, true);
  });
});

describe("RU_RESULT Decision Record", () => {
  it("catalog headings match the operator sections", () => {
    assert.equal(t("record.outcome", "ru"), "Итог");
    assert.equal(t("record.completed", "ru"), "Что сделано");
    assert.equal(t("record.notCompleted", "ru"), "Что не сделано");
    assert.equal(t("record.implementation", "ru"), "Состояние реализации");
    assert.equal(t("record.blockers", "ru"), "В чём затык");
    assert.equal(t("record.recommendations", "ru"), "Рекомендовано");
    assert.equal(t("record.required", "ru"), "Требуется");
    assert.equal(t("record.userActions", "ru"), "Действия пользователя");
    assert.equal(t("record.next", "ru"), "Следующий шаг");
    assert.equal(t("record.translationFailed", "ru"), "Русский перевод недоступен. Показан английский оригинал.");
  });

  it("RU display cache does not rerun Council", async () => {
    const record = deriveDecisionRecord({
      mode: "CREATE",
      runStatus: "COMPLETE",
      result: {
        taskId: "t-op",
        status: "READY_FOR_REVIEW",
        consensus: [],
        disagreements: [],
        blockers: [],
        recommendation: "review",
        agentPositions: {},
        synthesisRaw: "{}",
        synthesizerProposedStatus: "APPROVED",
        finalEnforcedStatus: "READY_FOR_REVIEW",
        reconciledStatus: "READY_FOR_REVIEW",
        verdictOverride: true,
        overrideReason: null,
        decision: null,
        rationale: null,
        dissent: [],
        reviewVerdict: null,
        alternatives: [],
        evidence: [],
        risks: [],
        issues: [],
        proposedCorrections: [],
        resolvedIssues: [],
        unresolvedIssues: [],
        citations: [],
        failedAgents: [],
        operatorRecord: SAMPLE_OPERATOR_RECORD,
      },
    });
    assert.equal(record.summary, SAMPLE_OPERATOR_RECORD.summary);
    const en = localizeDecisionRecordStatic(record, "en");
    const ruStatic = localizeDecisionRecordStatic(record, "ru");
    assert.equal(en.verdict, ruStatic.verdict);
    assert.equal(en.nextAction, ruStatic.nextAction);
    assert.equal(en.locale, "en");
    assert.equal(ruStatic.locale, "ru");
    let calls = 0;
    const counting: TranslateFn = async ({ text }) => {
      calls += 1;
      return `RU:${text}`;
    };
    const first = await localizeDecisionRecord(record, "ru", null, counting);
    assert.equal(first.translated, true);
    assert.match(first.view.summary, /^RU:/);
    assert.match(first.view.completed[0] ?? "", /^RU:/);
    assert.match(first.view.nextActionWhy, /^RU:/);
    const before = calls;
    const second = await localizeDecisionRecord(record, "ru", first.cache, counting);
    assert.equal(second.translated, false);
    assert.equal(second.view.fromCache, true);
    assert.equal(calls, before);
    const back = await localizeDecisionRecord(record, "en", first.cache, counting);
    assert.equal(back.translated, false);
    assert.equal(back.view.locale, "en");
    assert.equal(back.view.summary, SAMPLE_OPERATOR_RECORD.summary);
    assert.equal(calls, before);
  });
});
