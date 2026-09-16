import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatActivityAge,
  hasTaskVerdict,
  isTechnicalStage,
  memberOpState,
  operatorKind,
  operatorStage,
} from "./operator-status.ts";

describe("operator status", () => {
  it("maps a live run to WORKING and hides technical stages", () => {
    assert.equal(operatorKind({ terminal: null, hasVerdict: false }), "WORKING");
    assert.equal(operatorStage({ stage: "ROUND_2", status: "COUNCIL_ROUND_2", internalStage: "LEASE_WAIT" }), "ROUND_2");
    assert.equal(operatorStage({ stage: "PREPARING", internalStage: "PREFLIGHT_MODEL_PROBE", preflightPending: true }), "PROBE");
    assert.equal(operatorStage({ stage: "FINALIZING" }), "FINALIZE");
    assert.equal(isTechnicalStage("LEASE_WAIT"), true);
    assert.equal(isTechnicalStage("ROUND_2"), false);
  });

  it("COMPLETE without a verdict is an error, never a blank verdict", () => {
    assert.equal(operatorKind({ terminal: "COMPLETE", hasVerdict: true }), "COMPLETE");
    assert.equal(operatorKind({ terminal: "COMPLETE", hasVerdict: false }), "ERROR");
    assert.equal(operatorKind({ terminal: "FAILED", hasVerdict: false }), "ERROR");
    assert.equal(operatorKind({ terminal: "CANCELLED", hasVerdict: false }), "STOPPED");
    assert.equal(hasTaskVerdict({ status: "READY_FOR_REVIEW" }), true);
    assert.equal(hasTaskVerdict({ reconciledStatus: "BLOCKED" }), true);
    assert.equal(hasTaskVerdict(null), false);
  });

  it("maps member cards to operator states", () => {
    assert.equal(memberOpState({ state: "DONE" }), "READY");
    assert.equal(memberOpState({ state: "RUNNING" }), "WORKING");
    assert.equal(memberOpState({ state: "WAITING", detail: "PROBING" }), "WORKING");
    assert.equal(memberOpState({ state: "FAILED" }), "FAILED");
    assert.equal(memberOpState({ state: "WAITING" }), "WAITING");
  });

  it("formats last activity in Russian", () => {
    const now = Date.parse("2026-09-16T16:00:12.000Z");
    assert.equal(formatActivityAge("2026-09-16T16:00:00.000Z", now, "ru"), "12 сек назад");
    assert.equal(formatActivityAge("2026-09-16T16:00:10.000Z", now, "ru"), "только что");
    assert.equal(formatActivityAge(null, now, "ru"), "нет данных");
  });
});
