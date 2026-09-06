import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { councilAgentFailure, councilPartial, fillResponse, formatAgentCard, survivingResponses } from "./agents.ts";
import {
  classifyErrorClass,
  classifyHttp,
  containsSecret,
  formatProviderFailure,
  httpClassOfStatus,
  isRetryableFailure,
  providerFailure,
  retryDelayMs,
} from "./provider-error.ts";
import type { AgentResponse } from "./types.ts";

function response(agent: string, error: string | null = null): AgentResponse {
  return fillResponse({
    agent,
    taskId: "t",
    error,
    responseText: error ? "" : "ok",
    round: 1,
  });
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
    assert.equal(classifyErrorClass(null, "aborted by user").errorClass, "ABORTED");
    assert.equal(classifyErrorClass(null, "stream interrupted").errorClass, "STREAM_INTERRUPTED");
    assert.equal(classifyErrorClass(null, "empty response").errorClass, "EMPTY_RESPONSE");
    assert.equal(classifyErrorClass(429, "").errorClass, "RATE_LIMITED");
    assert.equal(classifyErrorClass(502, "").errorClass, "HTTP_ERROR");
    assert.equal(classifyErrorClass(null, "something odd").errorClass, "PROVIDER_ERROR");
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
    assert.match(text, /class RATE_LIMITED/);
    assert.match(text, /retries exhausted/);
    assert.match(text, /GROK round 1/);
    assert.equal(text.includes("Check API Settings"), false);
  });

  it("names 402 as payment required, not subscription credits", () => {
    const text = formatProviderFailure(
      providerFailure({
        provider: "openrouter",
        model: "openai/gpt-5",
        stage: "GPT round 1",
        httpStatus: 402,
      }),
    );
    assert.match(text, /HTTP 402/);
    assert.match(text, /class HTTP_ERROR/);
    assert.match(text, /Payment was required/);
    assert.equal(/subscription credits exhausted/i.test(text), false);
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
    assert.match(text, /class HTTP_ERROR/);
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
    assert.match(timeout, /class TIMEOUT/);
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
    assert.match(five, /class HTTP_ERROR/);
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
    assert.match(text, /class HTTP_ERROR/);
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
    assert.equal(isRetryableFailure({ httpClass: "429", errorClass: "RATE_LIMITED" }), true);
    assert.equal(isRetryableFailure({ httpClass: "5xx", errorClass: "HTTP_ERROR" }), true);
    assert.equal(isRetryableFailure({ httpClass: "timeout", errorClass: "TIMEOUT" }), true);
    assert.equal(isRetryableFailure({ httpClass: "network", errorClass: "NETWORK_ERROR" }), true);
    assert.equal(isRetryableFailure({ httpClass: "empty", errorClass: "EMPTY_RESPONSE" }), true);
    assert.equal(isRetryableFailure({ httpClass: "402", errorClass: "HTTP_ERROR" }), false);
    assert.equal(isRetryableFailure({ httpClass: "400", errorClass: "HTTP_ERROR" }), false);
    assert.equal(isRetryableFailure({ httpClass: "401", errorClass: "HTTP_ERROR" }), false);
    assert.equal(isRetryableFailure({ httpClass: "aborted", errorClass: "ABORTED" }), false);
    assert.equal(retryDelayMs(1) < 5000, true);
  });

  it("continues 2-of-3 when Grok 429 and GPT/Claude succeeded", () => {
    const rows = [
      response("GPT"),
      response("GROK", "OpenRouter x-ai/grok-4 failed in GROK round 1: HTTP 429 class RATE_LIMITED (retries exhausted). Rate limited."),
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

  it("never emits unknown or unclassified failure", () => {
    const unknown = formatProviderFailure(
      providerFailure({
        provider: "nanogpt",
        model: "google/gemma-2-9b",
        stage: "ADVERSARIAL round 1",
        attempt: 3,
        maxAttempts: 3,
        retryExhausted: true,
        raw: "weird provider blob",
      }),
    );
    assert.match(unknown, /NanoGPT/);
    assert.match(unknown, /google\/gemma-2-9b/);
    assert.match(unknown, /ADVERSARIAL round 1/);
    assert.match(unknown, /class PROVIDER_ERROR/);
    assert.match(unknown, /attempt 3\/3/);
    assert.match(unknown, /retries exhausted/);
    assert.equal(/unclassified failure/i.test(unknown), false);
    assert.equal(/class unknown/i.test(unknown), false);
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
    assert.match(five, /class HTTP_ERROR/);
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
    assert.match(card.lastError ?? "", /class RATE_LIMITED/);
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
