import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRequestCounter,
  emptyRequestBudget,
  isEmptyCompletion,
  isRequestLimitError,
  MAX_PROVIDER_ATTEMPTS,
  REQUEST_LIMIT_MESSAGE,
} from "./request-budget.ts";
import { catalogFromIds, MODEL_UNAVAILABLE_ON_PROVIDER } from "./catalog.ts";

describe("request budget", () => {
  it("starts empty at the hard ceiling of 12", () => {
    const snap = emptyRequestBudget();
    assert.equal(snap.used, 0);
    assert.equal(snap.limit, 12);
    assert.equal(snap.expected, 7);
    assert.equal(MAX_PROVIDER_ATTEMPTS, 12);
  });

  it("counts every attempt including retries", () => {
    const counter = createRequestCounter();
    for (let i = 0; i < 11; i += 1) counter.consume("GPT round 1");
    assert.equal(counter.used(), 11);
    counter.consume("GPT round 1");
    assert.equal(counter.used(), 12);
    assert.throws(() => counter.consume("GPT round 2"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(isRequestLimitError(err.message), true);
      assert.match(err.message, new RegExp(REQUEST_LIMIT_MESSAGE));
      assert.match(err.message, /GPT round 2/);
      return true;
    });
  });

  it("treats empty or whitespace completions as failures", () => {
    assert.equal(isEmptyCompletion(""), true);
    assert.equal(isEmptyCompletion("   \n"), true);
    assert.equal(isEmptyCompletion(null), true);
    assert.equal(isEmptyCompletion("POSITION\nok"), false);
  });

  it("scales the ceiling with 2 and 5 members", () => {
    assert.equal(emptyRequestBudget(2).expected, 5);
    assert.equal(emptyRequestBudget(2).limit, 9);
    assert.equal(emptyRequestBudget(5).expected, 11);
    assert.equal(emptyRequestBudget(5).limit, 18);
    const counter = createRequestCounter(2);
    for (let i = 0; i < 9; i += 1) counter.consume("LEAD_REASONER round 1");
    assert.throws(() => counter.consume("LEAD_REASONER round 2"), /request limit/);
  });
});

describe("catalog availability", () => {
  it("blocks missing models before paid execution", () => {
    const result = catalogFromIds("nanogpt", ["openai/gpt-5.6-sol", "missing/grok"], new Set(["openai/gpt-5.6-sol"]));
    assert.equal(result.ok, false);
    assert.equal(result.code, MODEL_UNAVAILABLE_ON_PROVIDER);
    assert.match(result.error ?? "", /MODEL_UNAVAILABLE/);
    assert.deepEqual(result.missing, ["missing/grok"]);
  });

  it("blocks an empty catalog as unreachable, not as success", () => {
    const result = catalogFromIds("openrouter", ["openai/gpt-5.6-sol"], new Set());
    assert.equal(result.ok, false);
    assert.equal(result.code, "PROVIDER_UNREACHABLE");
  });
});
