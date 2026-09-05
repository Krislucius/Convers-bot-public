import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { councilAgentFailure, councilPartial, formatAgentCard, survivingResponses } from "./agents.ts";
import {
  classifyHttp,
  containsSecret,
  formatProviderFailure,
  httpClassOfStatus,
  isRetryableFailure,
  providerFailure,
  retryDelayMs,
} from "./provider-error.ts";
import { normalizeAgentKey } from "./roles.ts";
import type { AgentResponse } from "./types.ts";

function response(agent: string, error: string | null = null): AgentResponse {
  const key = normalizeAgentKey(agent);
  return {
    id: key,
    taskId: "t",
    agent: key,
    round: 1,
    model: "m",
    provider: "openrouter",
    promptSnapshot: "",
    responseText: error ? "" : "ok",
    structured: null,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cost: null,
    requestId: null,
    latencyMs: null,
    error,
    contextManifestId: null,
    contextHash: null,
    runId: null,
  };
}

describe("provider failure formatting", () => {
  it("classifies HTTP families", () => {
    assert.equal(httpClassOfStatus(400), "400");
    assert.equal(httpClassOfStatus(401), "401");
    assert.equal(httpClassOfStatus(403), "401");
    assert.equal(httpClassOfStatus(402), "402");
    assert.equal(httpClassOfStatus(429), "429");
    assert.equal(httpClassOfStatus(502), "5xx");
    assert.equal(classifyHttp(null, "aborted due to timeout"), "timeout");
    assert.equal(classifyHttp(0, "failed to fetch"), "network");
  });

  it("names 429 retries exhausted without Check API Settings", () => {
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "x-ai/grok-4",
        stage: "GROK round 1",
        httpStatus: 429,
        retryExhausted: true,
      }),
    );
    assert.match(text, /HTTP 429/);
    assert.match(text, /retries exhausted/);
    assert.match(text, /GROK round 1/);
    assert.equal(text.includes("Check API Settings"), false);
  });

  it("names 402 credits", () => {
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "GPT round 1",
        httpStatus: 402,
      }),
    );
    assert.match(text, /HTTP 402/);
    assert.match(text, /credits/);
    assert.equal(text.includes("Check API Settings"), false);
  });

  it("names 400 without treating it as a key problem", () => {
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        stage: "CLAUDE round 1",
        httpStatus: 400,
      }),
    );
    assert.match(text, /HTTP 400/);
    assert.equal(text.includes("Check API Settings"), false);
  });

  it("names timeout and 5xx retry exhaustion", () => {
    const timeout = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "GPT round 1",
        httpClass: "timeout",
      }),
    );
    assert.match(timeout, /timeout/);
    const five = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "GPT round 1",
        httpStatus: 503,
        retryExhausted: true,
      }),
    );
    assert.match(five, /HTTP 503/);
    assert.match(five, /retries exhausted/);
  });

  it("keeps 401 as the only Check API Settings runtime class", () => {
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "complete",
        httpStatus: 401,
      }),
    );
    assert.match(text, /Check API Settings/);
  });

  it("does not leak key material", () => {
    const raw = "Unauthorized sk-or-fake-key-material Bearer secret";
    assert.equal(containsSecret(raw), true);
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "GPT round 1",
        httpStatus: 401,
        raw,
      }),
    );
    assert.equal(containsSecret(text), false);
    assert.equal(text.includes("sk-or-fake-key-material"), false);
    assert.equal(text.includes("Bearer secret"), false);
  });

  it("retries 429, 5xx, timeout, network, and empty responses", () => {
    assert.equal(isRetryableFailure({ httpClass: "429" }), true);
    assert.equal(isRetryableFailure({ httpClass: "5xx" }), true);
    assert.equal(isRetryableFailure({ httpClass: "timeout" }), true);
    assert.equal(isRetryableFailure({ httpClass: "network" }), true);
    assert.equal(isRetryableFailure({ httpClass: "empty" }), true);
    assert.equal(isRetryableFailure({ httpClass: "402" }), false);
    assert.equal(isRetryableFailure({ httpClass: "400" }), false);
    assert.equal(isRetryableFailure({ httpClass: "401" }), false);
    assert.equal(retryDelayMs(1) < 5000, true);
  });

  it("continues 2-of-3 when Grok 429 and GPT/Claude succeeded", () => {
    const rows = [
      response("GPT"),
      response("GROK", "OpenRouter x-ai/grok-4 failed in GROK round 1: HTTP 429 (retries exhausted). Rate limited."),
      response("CLAUDE"),
    ];
    assert.equal(survivingResponses(rows).length, 2);
    assert.equal(councilAgentFailure(rows), null);
  });

  it("fails the round when two providers fail", () => {
    const rows = [
      response("GPT", "HTTP 402"),
      response("GROK", "HTTP 429"),
      response("CLAUDE"),
    ];
    assert.equal(councilAgentFailure(rows)?.includes("HTTP 402"), true);
  });

  it("never collapses a runtime failure to generic provider error", () => {
    const unknown = formatProviderFailure(
      providerFailure({
        provider: "nanogpt",
        model: "google/gemma-2-9b",
        stage: "ADVERSARIAL round 1",
        httpClass: "unknown",
        attempt: 3,
        maxAttempts: 3,
        retryExhausted: true,
      }),
    );
    assert.match(unknown, /NanoGPT/);
    assert.match(unknown, /google\/gemma-2-9b/);
    assert.match(unknown, /ADVERSARIAL round 1/);
    assert.match(unknown, /class unknown/);
    assert.match(unknown, /attempt 3\/3/);
    assert.match(unknown, /retries exhausted/);
    assert.match(unknown, /unclassified failure/);
    assert.equal(unknown.includes("provider error"), false);
    const five = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4",
        stage: "FORMAL_REVIEW round 1",
        httpStatus: 502,
        attempt: 2,
        maxAttempts: 3,
      }),
    );
    assert.match(five, /HTTP 502/);
    assert.match(five, /class 5xx/);
    assert.equal(five.includes("provider error"), false);
  });

  it("formats one agent card with aggregated attempts and last error", () => {
    const err = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "google/gemma-2-9b",
        stage: "ADVERSARIAL round 1",
        httpStatus: 429,
        attempt: 3,
        maxAttempts: 3,
        retryExhausted: true,
      }),
    );
    const card = formatAgentCard("Gemma", { state: "FAILED", attempt: 3, maxAttempts: 3, error: err });
    assert.equal(card.title, "Gemma");
    assert.equal(card.status, "FAILED");
    assert.equal(card.attempts, "attempts 3/3");
    assert.equal(card.lastError, err);
    assert.match(card.lastError ?? "", /HTTP 429/);
    assert.match(card.lastError ?? "", /class 429/);
    assert.match(card.lastError ?? "", /attempt 3\/3/);
    assert.match(card.lastError ?? "", /retries exhausted/);
    const partial = councilPartial([
      response("CLAUDE"),
      response("GPT", err),
      response("GROK", err),
    ]);
    assert.equal(partial.ok, false);
    assert.equal(partial.survivors.length, 1);
    assert.match(partial.reason, /Synthesis was not created/);
  });
});
