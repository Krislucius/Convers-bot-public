import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_NANOGPT_BILLING,
  NANOGPT_PAYG_COMPLETE_URL,
  NANOGPT_PAYG_MODELS_URL,
  NANOGPT_SUBSCRIPTION_COMPLETE_URL,
  NANOGPT_SUBSCRIPTION_MODELS_URL,
  NANOGPT_SUBSCRIPTION_BASE,
  assertSingleBilling,
  billingLabel,
  classifyNanoGptError,
  forbiddenSubscriptionExhaustionPhrase,
  formatNanoGptError,
  isPaygUrl,
  isSubscriptionUrl,
  mixedBillingUrls,
  nanogptEndpoints,
  normalizeNanoGptBilling,
  paygOnlyIds,
  resolveNanoGptBilling,
} from "./nano-billing.ts";
import { complete as nanoComplete, discoverAccount, listCatalog } from "./nanogpt.server.ts";
import { formatProviderFailure, providerFailure } from "./provider-error.ts";
import { discoverAccountWith, verifySelectedWith, type ProviderTransport } from "./provider-discover.ts";
import { runCouncil } from "./orchestrate.ts";
import type { CouncilMember } from "./members.ts";
import type { ProviderCreds, Task } from "./types.ts";
import type { EvidencePipelineResult } from "../evidence/pipeline-cache.ts";

const SUB_MODELS = [
  { id: "openai/gpt-5", name: "GPT-5", context_length: 200000 },
  { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000 },
  { id: "deepseek/deepseek-r1", name: "DeepSeek R1", context_length: 64000 },
];
const PAYG_ONLY = { id: "openai/gpt-5-pro-payg", name: "GPT-5 Pro PAYG", context_length: 200000 };
const PAYG_MODELS = [...SUB_MODELS, PAYG_ONLY];

function jsonResponse(url: string, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-test-url": url },
  });
}

describe("NanoGPT billing endpoints", () => {
  it("keeps subscription and PAYG catalogs on separate URLs", () => {
    const sub = nanogptEndpoints("subscription");
    const payg = nanogptEndpoints("payg");
    assert.equal(sub.catalogUrl, NANOGPT_SUBSCRIPTION_MODELS_URL);
    assert.equal(sub.completeUrl, NANOGPT_SUBSCRIPTION_COMPLETE_URL);
    assert.equal(payg.catalogUrl, NANOGPT_PAYG_MODELS_URL);
    assert.equal(payg.completeUrl, NANOGPT_PAYG_COMPLETE_URL);
    assert.notEqual(sub.catalogUrl, payg.catalogUrl);
    assert.notEqual(sub.completeUrl, payg.completeUrl);
    assert.equal(sub.catalogUrl.includes("detailed=true"), true);
    assert.equal(isSubscriptionUrl(sub.catalogUrl), true);
    assert.equal(isPaygUrl(payg.catalogUrl), true);
    assert.equal(isPaygUrl(sub.catalogUrl), false);
    assert.equal(isSubscriptionUrl(payg.completeUrl), false);
  });

  it("defaults to Subscription and never auto-selects PAYG", () => {
    assert.equal(DEFAULT_NANOGPT_BILLING, "subscription");
    assert.equal(normalizeNanoGptBilling(undefined), "subscription");
    assert.equal(resolveNanoGptBilling({ subscriptionCatalogAvailable: true }), "subscription");
    assert.equal(resolveNanoGptBilling({ subscriptionCatalogAvailable: false }), "subscription");
    assert.equal(resolveNanoGptBilling({ explicit: "payg" }), "payg");
    assert.equal(resolveNanoGptBilling({ explicit: "subscription", subscriptionCatalogAvailable: false }), "subscription");
    assert.equal(billingLabel("subscription"), "SUBSCRIPTION");
    assert.equal(billingLabel("payg"), "PAYG");
  });

  it("rejects PAYG-only models from a Subscription Council", () => {
    const leaked = paygOnlyIds(
      ["openai/gpt-5", "openai/gpt-5-pro-payg", "anthropic/claude-sonnet-4"],
      SUB_MODELS.map((row) => row.id),
    );
    assert.deepEqual(leaked, ["openai/gpt-5-pro-payg"]);
  });
});

describe("NanoGPT error classification", () => {
  it("does not report PAYG 402 as subscription exhaustion", () => {
    const code = classifyNanoGptError({ billing: "payg", status: 402, raw: "Payment required: add balance" });
    assert.equal(code, "PAYG_BALANCE_REQUIRED");
    const text = formatNanoGptError({ code, status: 402, providerMessage: "Payment required: add balance" });
    assert.match(text, /PAYG_BALANCE_REQUIRED/);
    assert.match(text, /HTTP 402/);
    assert.match(text, /Payment required: add balance/);
    assert.equal(forbiddenSubscriptionExhaustionPhrase(text), false);
    assert.equal(/subscription credits exhausted/i.test(text), false);
    const formatted = formatProviderFailure(
      providerFailure({
        provider: "nanogpt",
        model: "openai/gpt-5",
        stage: "LEAD_REASONER round 1",
        httpStatus: 402,
        httpClass: "402",
        code: "PAYG_BALANCE_REQUIRED",
        detail: "Payment required: add balance",
      }),
    );
    assert.match(formatted, /PAYG_BALANCE_REQUIRED/);
    assert.match(formatted, /HTTP 402/);
    assert.equal(formatted.includes("subscription credits exhausted"), false);
    assert.equal(formatted.toLowerCase().includes("provider error"), false);
  });

  it("classifies subscription quota and rate errors distinctly", () => {
    assert.equal(
      classifyNanoGptError({ billing: "subscription", status: 402, raw: "quota exceeded" }),
      "SUBSCRIPTION_LIMIT_REACHED",
    );
    assert.equal(
      classifyNanoGptError({ billing: "subscription", status: 429, raw: "rate limit" }),
      "RATE_LIMITED",
    );
    assert.equal(
      classifyNanoGptError({
        billing: "subscription",
        status: 403,
        raw: "model not included in your subscription",
      }),
      "MODEL_NOT_INCLUDED",
    );
    assert.equal(
      classifyNanoGptError({ billing: "subscription", status: 404, raw: "model_not_found" }),
      "MODEL_UNAVAILABLE",
    );
    assert.equal(classifyNanoGptError({ billing: "subscription", status: 500, raw: "upstream" }), "PROVIDER_ERROR");
    const quota = formatNanoGptError({
      code: "SUBSCRIPTION_LIMIT_REACHED",
      status: 402,
      providerMessage: "daily token quota exceeded",
    });
    assert.match(quota, /SUBSCRIPTION_LIMIT_REACHED/);
    assert.match(quota, /HTTP 402/);
    assert.equal(forbiddenSubscriptionExhaustionPhrase(quota), false);
    const named = formatProviderFailure(
      providerFailure({
        provider: "nanogpt",
        model: "openai/gpt-5",
        stage: "complete",
        httpStatus: 500,
        code: "PROVIDER_ERROR",
        detail: "upstream",
      }),
    );
    assert.match(named, /PROVIDER_ERROR/);
    assert.equal(named.includes("provider error"), false);
  });
});

function recordedTransport(mode: "subscription" | "payg", urls: string[]): ProviderTransport {
  const endpoints = nanogptEndpoints(mode);
  const catalog = mode === "subscription" ? SUB_MODELS : PAYG_MODELS;
  return {
    provider: "nanogpt",
    label: "NanoGPT",
    billingMode: mode,
    catalogUrl: endpoints.catalogUrl,
    completeUrl: endpoints.completeUrl,
    creditMessage:
      mode === "payg" ? "Pay-as-you-go balance is required." : "Subscription limit reached.",
    listModels: async () => {
      urls.push(endpoints.catalogUrl);
      return { status: 200, body: JSON.stringify({ data: catalog }) };
    },
    pingModel: async (_key, modelId) => {
      urls.push(endpoints.completeUrl);
      const known = catalog.some((row) => row.id === modelId);
      if (!known) {
        return { status: 403, body: JSON.stringify({ error: { message: "model not included in your subscription" } }) };
      }
      return { status: 200, body: "{}" };
    },
  };
}

describe("subscription catalog vs generic catalog", () => {
  it("discovers different models and never recommends PAYG-only ids in Subscription", async () => {
    const subUrls: string[] = [];
    const paygUrls: string[] = [];
    const sub = await discoverAccountWith(
      recordedTransport("subscription", subUrls),
      "sk-nano-THISISASECRETKEYVALUE99",
    );
    const payg = await discoverAccountWith(recordedTransport("payg", paygUrls), "sk-nano-THISISASECRETKEYVALUE99");
    assert.equal(sub.ok, true);
    assert.equal(payg.ok, true);
    const subIds = sub.snapshot?.models.map((row) => row.id) ?? [];
    const paygIds = payg.snapshot?.models.map((row) => row.id) ?? [];
    assert.equal(subIds.includes("openai/gpt-5-pro-payg"), false);
    assert.equal(paygIds.includes("openai/gpt-5-pro-payg"), true);
    assert.ok(subIds.length < paygIds.length);
    assert.equal(sub.snapshot?.recommendedIds.includes("openai/gpt-5-pro-payg"), false);
    assert.equal(sub.snapshot?.billingMode, "subscription");
    assert.equal(payg.snapshot?.billingMode, "payg");
    assertSingleBilling("subscription", subUrls);
    assertSingleBilling("payg", paygUrls);
    assert.deepEqual(mixedBillingUrls("subscription", subUrls), []);
  });

  it("blocks a PAYG-only model from Subscription verify and does not probe PAYG", async () => {
    const urls: string[] = [];
    const transport = recordedTransport("subscription", urls);
    const denied = await verifySelectedWith(transport, "sk-nano-THISISASECRETKEYVALUE99", [
      "openai/gpt-5",
      "openai/gpt-5-pro-payg",
    ]);
    assert.equal(denied.ok, false);
    assert.equal(denied.blocked.some((row) => row.id === "openai/gpt-5-pro-payg"), true);
    assertSingleBilling("subscription", urls);
    assert.equal(urls.some((url) => isPaygUrl(url)), false);
  });
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installNanoFetch(opts: {
  mode: "subscription" | "payg";
  urls: string[];
  completeStatus?: number;
  completeBody?: unknown;
}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    opts.urls.push(url);
    if (init?.method === "GET" || !init?.method) {
      const catalog = opts.mode === "subscription" ? SUB_MODELS : PAYG_MODELS;
      return jsonResponse(url, 200, { object: "list", data: catalog });
    }
    return jsonResponse(url, opts.completeStatus ?? 200, opts.completeBody ?? {
      id: "cmpl_test",
      model: "openai/gpt-5",
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;
}

describe("NanoGPT live routing", () => {
  it("executes subscription models through the subscription endpoint with no PAYG fallback", async () => {
    const urls: string[] = [];
    installNanoFetch({ mode: "subscription", urls });
    const catalog = await listCatalog("sk-nano-THISISASECRETKEYVALUE99", "subscription");
    assert.equal(catalog.ok, true);
    if (catalog.ok) {
      assert.equal(catalog.entries.some((row) => row.id === "openai/gpt-5-pro-payg"), false);
    }
    await nanoComplete({
      apiKey: "sk-nano-THISISASECRETKEYVALUE99",
      model: "openai/gpt-5",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      temperature: 0,
      nanogptBilling: "subscription",
    });
    const discovered = await discoverAccount("sk-nano-THISISASECRETKEYVALUE99", ["openai/gpt-5"], "subscription");
    assert.equal(discovered.ok, true);
    assertSingleBilling("subscription", urls);
    assert.ok(urls.some((url) => url === NANOGPT_SUBSCRIPTION_MODELS_URL || url.startsWith(NANOGPT_SUBSCRIPTION_BASE)));
    assert.ok(urls.includes(NANOGPT_SUBSCRIPTION_COMPLETE_URL));
    assert.equal(urls.some((url) => isPaygUrl(url)), false);
  });

  it("uses generic PAYG URLs only when PAYG is selected", async () => {
    const urls: string[] = [];
    installNanoFetch({ mode: "payg", urls });
    await listCatalog("sk-nano-THISISASECRETKEYVALUE99", "payg");
    await nanoComplete({
      apiKey: "sk-nano-THISISASECRETKEYVALUE99",
      model: "openai/gpt-5-pro-payg",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      temperature: 0,
      nanogptBilling: "payg",
    });
    assertSingleBilling("payg", urls);
    assert.ok(urls.includes(NANOGPT_PAYG_MODELS_URL));
    assert.ok(urls.includes(NANOGPT_PAYG_COMPLETE_URL));
    assert.equal(urls.some((url) => isSubscriptionUrl(url)), false);
  });

  it("classifies a PAYG 402 without calling it subscription exhaustion", async () => {
    const urls: string[] = [];
    installNanoFetch({
      mode: "payg",
      urls,
      completeStatus: 402,
      completeBody: { error: { message: "Payment required: add balance" } },
    });
    await assert.rejects(
      () =>
        nanoComplete({
          apiKey: "sk-nano-THISISASECRETKEYVALUE99",
          model: "openai/gpt-5",
          messages: [{ role: "user", content: "ping" }],
          maxTokens: 8,
          temperature: 0,
          nanogptBilling: "payg",
        }),
      (err: unknown) => {
        const text = err instanceof Error ? err.message : String(err);
        assert.match(text, /PAYG_BALANCE_REQUIRED/);
        assert.match(text, /402/);
        assert.equal(forbiddenSubscriptionExhaustionPhrase(text), false);
        return true;
      },
    );
    assertSingleBilling("payg", urls);
  });
});

const members: CouncilMember[] = [
  { memberId: "m_lead", role: "LEAD_REASONER", modelId: "openai/gpt-5", label: "GPT-5", family: "openai" },
  { memberId: "m_adv", role: "ADVERSARIAL", modelId: "deepseek/deepseek-r1", label: "DeepSeek R1", family: "deepseek" },
  { memberId: "m_form", role: "FORMAL_REVIEW", modelId: "anthropic/claude-sonnet-4", label: "Claude", family: "anthropic" },
];

const pipeline: EvidencePipelineResult = {
  chunks: [],
  entries: [],
  coverage: {
    status: "COMPLETE",
    meaning: "COMPLETE means every selected chunk was processed.",
    sources: [],
    audit: {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksWithEvidence: 0,
      chunksWithoutEvidence: 0,
      evidenceCount: 0,
      packedEvidence: 0,
      omittedEvidence: 0,
    },
    chunkCount: 0,
    evidenceCount: 0,
    cacheHits: 0,
    extractorFingerprint: "x",
    chunkerVersion: "chunker-v1",
  },
  pack: {
    ok: true,
    code: "OK",
    text: "INVARIANTS\nnone",
    packed: [],
    omitted: [],
    mandatoryTokens: 4,
    evidenceTokens: 0,
    totalTokens: 4,
  },
  manifest: {
    extractorFingerprint: "x",
    chunkerVersion: "chunker-v1",
    packerVersion: "packer-v2",
    coverageStatus: "COMPLETE",
    coverageMeaning: "COMPLETE",
    ledgerHash: "l",
    contextHash: "c",
    selectedSourceHashes: [],
    sources: [],
    packedCitations: [],
    omitted: [],
    audit: {
      chunksTotal: 0,
      chunksProcessed: 0,
      chunksWithEvidence: 0,
      chunksWithoutEvidence: 0,
      evidenceCount: 0,
      packedEvidence: 0,
      omittedEvidence: 0,
    },
    evidenceCount: 0,
    chunkCount: 0,
    cacheHits: 0,
    processedChunks: 0,
  },
};

const task: Task = {
  id: "task-billing",
  projectId: "p1",
  title: "Billing",
  prompt: "Keep one billing mode.",
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
  decisionQuestion: "Which mode?",
  contextManifestId: null,
  contextHash: null,
  provider: "nanogpt",
  nanogptBilling: "subscription",
};

describe("Council billing freeze", () => {
  it("uses one NanoGPT billing mode for round 1, round 2, and synthesis", async () => {
    const billings: Array<string | undefined> = [];
    const creds: ProviderCreds = {
      provider: "nanogpt",
      apiKey: "sk-nano-THISISASECRETKEYVALUE99",
      members,
      synthesizerModel: "",
      maxCostUsd: 5,
      nanogptBilling: "subscription",
    };
    const out = await runCouncil({
      creds,
      project: { id: "p1", name: "P", description: "billing" },
      context: [],
      task,
      pipeline,
      runtime: {
        completeChat: async (opts) => {
          billings.push(opts.nanogptBilling);
          if (opts.responseFormat) {
            return {
              ok: true,
              completion: {
                text: JSON.stringify({
                  status: "APPROVED",
                  consensus: ["ok"],
                  disagreements: [],
                  blockers: [],
                  recommendation: "go",
                  agent_positions: { LEAD_REASONER: "a", ADVERSARIAL: "b", FORMAL_REVIEW: "c" },
                  decision: "keep",
                  rationale: "one billing mode",
                  dissent: [],
                }),
                model: opts.model,
                inputTokens: 8,
                cachedInputTokens: 0,
                outputTokens: 8,
                reasoningTokens: 0,
                cost: 0.001,
                requestId: "s",
                latencyMs: 5,
              },
            };
          }
          return {
            ok: true,
            completion: {
              text: `POSITION\n${opts.model} ok\nRECOMMENDATION\ngo`,
              model: opts.model,
              inputTokens: 8,
              cachedInputTokens: 0,
              outputTokens: 8,
              reasoningTokens: 0,
              cost: 0.001,
              requestId: "r",
              latencyMs: 5,
            },
          };
        },
        yieldFn: async () => undefined,
      },
    });
    assert.equal(out.task.status, "COMPLETE");
    assert.equal(out.task.nanogptBilling, "subscription");
    assert.equal(out.task.diagnostics?.run?.nanogptBilling, "subscription");
    assert.ok(billings.length >= 7);
    assert.deepEqual([...new Set(billings)], ["subscription"]);
  });
});
