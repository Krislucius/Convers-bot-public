import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureMembers } from "./members.ts";
import {
  evaluatePreflightGate,
  interpretAccessForModel,
  nextPreflightStep,
  parseSubscriptionUsage,
  patchPreflightStep,
  seedPreflight,
  subscriptionBlocksRun,
} from "./start-preflight.ts";

const members = ensureMembers([
  { role: "LEAD_REASONER", modelId: "kimi/k2", label: "Kimi" },
  { role: "ADVERSARIAL", modelId: "qwen/qwen", label: "Qwen" },
  { role: "FORMAL_REVIEW", modelId: "xiaomi/mimo", label: "MiMo" },
  { role: "RESEARCH", modelId: "deepseek/r1", label: "R1" },
]);

describe("start preflight", () => {
  it("seeds PROVIDER, SUBSCRIPTION, CATALOG, then one step per selected model", () => {
    const report = seedPreflight({ members, provider: "nanogpt", nanogptBilling: "subscription" });
    assert.equal(report.steps[0]?.label, "PROVIDER CHECK");
    assert.equal(report.steps[1]?.label, "SUBSCRIPTION");
    assert.equal(report.steps[2]?.label, "CATALOG");
    assert.equal(report.steps.filter((step) => step.kind === "MODEL").length, 4);
    assert.equal(nextPreflightStep(report)?.kind, "PROVIDER");
  });

  it("skips subscription usage on non-NanoGPT and PAYG", () => {
    const or = seedPreflight({ members: members.slice(0, 2), provider: "openrouter" });
    assert.equal(or.steps.find((step) => step.kind === "SUBSCRIPTION")?.status, "SKIPPED");
    const payg = seedPreflight({ members: members.slice(0, 2), provider: "nanogpt", nanogptBilling: "payg" });
    assert.equal(payg.steps.find((step) => step.kind === "SUBSCRIPTION")?.status, "SKIPPED");
  });

  it("blocks inactive or exhausted subscription", () => {
    assert.match(subscriptionBlocksRun(parseSubscriptionUsage({ active: false }, 200), 200) ?? "", /inactive/i);
    assert.match(subscriptionBlocksRun(parseSubscriptionUsage({ remaining: 0, limit: 10 }, 200), 200) ?? "", /LIMIT/);
    assert.match(subscriptionBlocksRun(parseSubscriptionUsage({}, 402), 402) ?? "", /LIMIT/);
    assert.equal(subscriptionBlocksRun(parseSubscriptionUsage({ active: true, remaining: 9, limit: 10 }, 200), 200), null);
  });

  it("starts when at least 2 selected models are callable and one catalog miss or probe fail remains", () => {
    let report = seedPreflight({ members, provider: "openrouter" });
    for (const step of report.steps) {
      if (step.kind === "MODEL") continue;
      report = patchPreflightStep(report, { ...step, status: step.kind === "SUBSCRIPTION" ? "SKIPPED" : "PASS" });
    }
    const models = report.steps.filter((step) => step.kind === "MODEL");
    report = patchPreflightStep(report, {
      ...models[0]!,
      status: "PASS",
      access: "VERIFIED_AVAILABLE",
    });
    report = patchPreflightStep(report, {
      ...models[1]!,
      status: "PASS",
      access: "VERIFIED_AVAILABLE",
    });
    report = patchPreflightStep(report, {
      ...models[2]!,
      status: "FAILED",
      access: "UNAVAILABLE",
      error: "not in catalog",
    });
    report = patchPreflightStep(report, {
      ...models[3]!,
      status: "FAILED",
      access: "UNKNOWN",
      error: "timeout",
    });
    const gate = evaluatePreflightGate(report);
    assert.equal(gate.ok, true);
    assert.equal(gate.callable.length, 2);
  });

  it("blocks when fewer than 2 selected models are currently callable", () => {
    let report = seedPreflight({ members: members.slice(0, 3), provider: "openrouter" });
    for (const step of report.steps) {
      if (step.kind === "MODEL") continue;
      report = patchPreflightStep(report, { ...step, status: step.kind === "SUBSCRIPTION" ? "SKIPPED" : "PASS" });
    }
    const models = report.steps.filter((step) => step.kind === "MODEL");
    report = patchPreflightStep(report, { ...models[0]!, status: "PASS", access: "VERIFIED_AVAILABLE" });
    report = patchPreflightStep(report, { ...models[1]!, status: "FAILED", access: "NOT_INCLUDED" });
    report = patchPreflightStep(report, { ...models[2]!, status: "FAILED", access: "UNAVAILABLE" });
    const gate = evaluatePreflightGate(report);
    assert.equal(gate.ok, false);
    assert.match(gate.error ?? "", /only 1 of 2/);
  });

  it("treats bulk accessCheck blocked lists per model so other models can still pass", () => {
    const interpreted = interpretAccessForModel("kimi/k2", {
      ok: false,
      blocked: [{ id: "qwen/qwen", access: "NOT_INCLUDED" }],
      error: "MODEL_UNAVAILABLE: qwen/qwen",
    });
    assert.equal(interpreted.access, "VERIFIED_AVAILABLE");
  });
});
