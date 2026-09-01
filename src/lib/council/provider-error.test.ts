import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { councilAgentFailure, survivingResponses } from "./agents.ts";
import {
  classifyHttp,
  containsSecret,
  formatProviderFailure,
  httpClassOfStatus,
  isRetryableFailure,
  providerFailure,
  retryDelayMs,
} from "./provider-error.ts";
import type { AgentResponse } from "./types.ts";

function response(agent: AgentResponse["agent"], error: string | null = null): AgentResponse {
  return {
    id: agent,
    taskId: "t",
    agent,
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

  it("retries only 429 and 5xx", () => {
    assert.equal(isRetryableFailure({ httpClass: "429" }), true);
    assert.equal(isRetryableFailure({ httpClass: "5xx" }), true);
    assert.equal(isRetryableFailure({ httpClass: "402" }), false);
    assert.equal(isRetryableFailure({ httpClass: "400" }), false);
    assert.equal(isRetryableFailure({ httpClass: "timeout" }), false);
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
});
