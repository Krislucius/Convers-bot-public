import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adapterFromTransport,
  adapterMode,
  sameProviderScan,
  type ProviderTransport,
} from "./provider-adapter.ts";
import {
  availableModels,
  buildDiscovery,
  classifyProbe,
  isVerifiedAvailable,
  normalizeCatalogPayload,
  pruneToAvailable,
  scoreModel,
} from "./discover.ts";
import { discoverAccountWith, verifySelectedWith } from "./provider-discover.ts";
import { applyDiscovery, selectionAfterScan } from "./settings-scan.ts";
import { formatTestLog } from "./test-log.ts";
import { adapter as nanoAdapter, transport as nanoTransport } from "./nanogpt.server.ts";
import { adapter as openrouterAdapter, transport as openrouterTransport } from "./openrouter.server.ts";
import { adapter as openrusAdapter, transport as openrusTransport } from "./openrusrouter.server.ts";
import { nanogptEndpoints } from "./nano-billing.ts";
import { containsSecret } from "./provider-error.ts";
import type { ProviderId } from "./types.ts";

const SECRET_NANO = "sk-nano-THISISASECRETKEYVALUE99";
const SECRET_OR = "sk-or-THISISASECRETKEYVALUE99";
const SECRET_ORR = "orr_test_THISISASECRETKEYVALUE99";

function mockTransport(opts: {
  provider: ProviderId;
  billingMode?: "subscription" | "payg";
  catalog: unknown;
  catalogStatus?: number;
  ping?: (id: string) => { status: number; body: string };
}): ProviderTransport {
  const endpoints =
    opts.provider === "nanogpt" ? nanogptEndpoints(opts.billingMode ?? "subscription") : undefined;
  return {
    provider: opts.provider,
    label: opts.provider,
    billingMode: opts.billingMode,
    catalogUrl: endpoints?.catalogUrl,
    completeUrl: endpoints?.completeUrl,
    creditMessage: "credits required",
    listModels: async () => ({
      status: opts.catalogStatus ?? 200,
      body: JSON.stringify(opts.catalog),
      latencyMs: 4,
    }),
    pingModel: async (_key, id) => opts.ping?.(id) ?? { status: 200, body: "{}" },
  };
}

const diverseCatalog = {
  data: [
    { id: "qwen/qwen3-coder", name: "Qwen Coder", context_length: 128000, description: "code architect" },
    { id: "mistralai/mistral-large", name: "Mistral Large", context_length: 128000 },
    { id: "google/gemini-2.5-pro", name: "Gemini Pro", context_length: 200000, reasoning: true },
    { id: "perplexity/sonar-reasoning", name: "Sonar", context_length: 127000, description: "search research" },
    { id: "meta-llama/llama-3.3-70b", name: "Llama 70B", context_length: 128000 },
    { id: "qwen/qwen-tiny", name: "Tiny", context_length: 8000 },
  ],
};

describe("provider adapter contract", () => {
  it("exposes one interface for NanoGPT, OpenRouter, and OpenRusRouter", () => {
    const nanoSub = nanoAdapter("subscription");
    const nanoPayg = nanoAdapter("payg");
    const or = openrouterAdapter();
    const orr = openrusAdapter();
    for (const adapter of [nanoSub, nanoPayg, or, orr]) {
      assert.equal(typeof adapter.testConnection, "function");
      assert.equal(typeof adapter.listModels, "function");
      assert.equal(typeof adapter.normalizeCatalog, "function");
      assert.equal(typeof adapter.probeModel, "function");
      assert.equal(typeof adapter.classifyAccess, "function");
      assert.equal(typeof adapter.classifyVerified, "function");
      assert.equal(typeof adapter.getCapabilities, "function");
      assert.ok(adapter.fingerprint.includes(adapter.id));
      assert.ok(adapter.mode);
    }
    assert.equal(nanoSub.mode, "subscription");
    assert.equal(nanoSub.fingerprint, "nanogpt:subscription");
    assert.equal(nanoPayg.mode, "payg");
    assert.equal(nanoPayg.fingerprint, "nanogpt:payg");
    assert.equal(nanoSub.catalogUrl, nanogptEndpoints("subscription").catalogUrl);
    assert.equal(nanoPayg.catalogUrl, nanogptEndpoints("payg").catalogUrl);
    assert.notEqual(nanoSub.catalogUrl, nanoPayg.catalogUrl);
    assert.equal(or.mode, "default");
    assert.equal(or.fingerprint, "openrouter:default");
    assert.equal(orr.mode, "default");
    assert.equal(orr.fingerprint, "openrusrouter:default");
    assert.equal(adapterMode("nanogpt", "payg"), "payg");
    assert.equal(adapterMode("openrouter"), "default");
  });

  it("wraps the live server transports without mixing billing endpoints", () => {
    const sub = nanoTransport("subscription");
    const payg = nanoTransport("payg");
    assert.match(sub.catalogUrl ?? "", /subscription\/v1\/models/);
    assert.match(payg.catalogUrl ?? "", /\/api\/v1\/models/);
    assert.equal(/subscription/.test(payg.completeUrl ?? ""), false);
    assert.match(openrouterTransport().catalogUrl ?? "", /openrouter\.ai/);
    assert.match(openrusTransport().catalogUrl ?? "", /openrusrouter\.ru/);
  });
});

describe("model discovery across providers", () => {
  it("CONNECT → DISCOVER → VERIFY for NanoGPT Subscription", async () => {
    const transport = mockTransport({
      provider: "nanogpt",
      billingMode: "subscription",
      catalog: diverseCatalog,
      ping: (id) =>
        id.includes("tiny")
          ? { status: 403, body: "model not included in your subscription" }
          : { status: 200, body: "{}" },
    });
    const adapter = adapterFromTransport(transport);
    const connected = await adapter.testConnection(SECRET_NANO);
    assert.equal(connected.ok, true);
    const listed = await adapter.listModels(SECRET_NANO);
    const norm = adapter.normalizeCatalog(JSON.parse(listed.body));
    assert.equal(norm.ok, true);
    assert.equal(norm.shape, "openai_data_array");
    const result = await discoverAccountWith(adapter, SECRET_NANO, ["qwen/qwen-tiny"]);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.mode, "subscription");
    assert.equal(result.snapshot?.fingerprint, "nanogpt:subscription");
    const tiny = result.snapshot?.models.find((row) => row.id === "qwen/qwen-tiny");
    assert.equal(tiny?.access, "NOT_INCLUDED");
    assert.equal(result.snapshot?.recommendedIds.includes("qwen/qwen-tiny"), false);
    assert.match(result.log, /"mode": "subscription"/);
    assert.match(result.log, /"verified_available"/);
    assert.equal(result.log.includes(SECRET_NANO), false);
  });

  it("NanoGPT PAYG uses a separate fingerprint and catalog", async () => {
    const transport = mockTransport({
      provider: "nanogpt",
      billingMode: "payg",
      catalog: { data: [{ id: "openai/gpt-5-pro-payg", name: "PAYG Pro" }, { id: "qwen/qwen3-coder", name: "Coder" }] },
    });
    const result = await discoverAccountWith(adapterFromTransport(transport), SECRET_NANO);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.mode, "payg");
    assert.equal(result.snapshot?.fingerprint, "nanogpt:payg");
    assert.match(result.log, /"mode": "payg"/);
    assert.equal(
      sameProviderScan(result.snapshot, "nanogpt", "subscription"),
      "Scan belongs to nanogpt:payg, not nanogpt:subscription. Refresh models.",
    );
  });

  it("OpenRouter discovery classifies catalog-visible inaccessible models", async () => {
    const transport = mockTransport({
      provider: "openrouter",
      catalog: [
        { id: "anthropic/claude-opus-4", name: "Opus", context_length: 200000 },
        { id: "openai/gpt-premium-only", name: "Premium" },
      ],
      ping: (id) =>
        id.includes("premium")
          ? { status: 403, body: "no access to this model" }
          : { status: 200, body: "{}" },
    });
    const result = await discoverAccountWith(adapterFromTransport(transport), SECRET_OR, [
      "anthropic/claude-opus-4",
      "openai/gpt-premium-only",
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.provider, "openrouter");
    assert.equal(result.snapshot?.mode, "default");
    assert.equal(result.snapshot?.fingerprint, "openrouter:default");
    assert.equal(result.snapshot?.catalogShape, "direct_array");
    const premium = result.snapshot?.models.find((row) => row.id === "openai/gpt-premium-only");
    assert.equal(premium?.access, "NOT_INCLUDED");
    assert.equal(isVerifiedAvailable(premium?.access), false);
    const opus = result.snapshot?.models.find((row) => row.id === "anthropic/claude-opus-4");
    assert.equal(opus?.access, "VERIFIED_AVAILABLE");
    assert.match(result.log, /"provider": "openrouter"/);
    assert.equal(result.log.includes(SECRET_OR), false);
  });

  it("OpenRusRouter discovery uses the same adapter flow", async () => {
    const transport = mockTransport({
      provider: "openrusrouter",
      catalog: { data: [{ id: "qwen/qwen3-coder", name: "Coder" }, { id: "mistralai/mistral-large", name: "Mistral" }] },
    });
    const result = await discoverAccountWith(adapterFromTransport(transport), SECRET_ORR);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.fingerprint, "openrusrouter:default");
    assert.equal(availableModels(result.snapshot?.models ?? []).length >= 2, true);
    assert.match(result.log, /"provider": "openrusrouter"/);
    assert.equal(result.log.includes(SECRET_ORR), false);
    assert.equal(containsSecret(result.log), false);
  });

  it("parses OpenAI data[] and direct-array catalog shapes and fails closed on others", () => {
    const adapter = adapterFromTransport(mockTransport({ provider: "openrouter", catalog: [] }));
    assert.equal(adapter.normalizeCatalog({ data: [{ id: "a/b" }] }).shape, "openai_data_array");
    assert.equal(adapter.normalizeCatalog([{ id: "a/b" }]).shape, "direct_array");
    const bad = adapter.normalizeCatalog({ models: [{ id: "a/b" }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "CATALOG_PARSE_ERROR");
  });
});

describe("recommendations from verified models only", () => {
  it("ranks capability, not hardcoded GPT/Claude/Grok/DeepSeek/Kimi ids", () => {
    const entries = normalizeCatalogPayload(diverseCatalog).entries;
    const discovery = buildDiscovery(
      "openrouter",
      entries,
      entries.map((row) => ({ id: row.id, status: 200, body: "{}" })),
    );
    assert.ok(discovery.recommendedIds.length >= 3);
    assert.ok(discovery.recommendedIds.length <= 5);
    for (const id of discovery.recommendedIds) {
      assert.equal(discovery.models.find((row) => row.id === id)?.access, "VERIFIED_AVAILABLE");
    }
    assert.equal(discovery.recommendedIds.includes("qwen/qwen-tiny"), false);
    assert.ok(scoreModel(entries.find((row) => row.id === "google/gemini-2.5-pro")!) > scoreModel(entries.find((row) => row.id === "qwen/qwen-tiny")!));
    const families = new Set(discovery.recommendedIds.map((id) => discovery.models.find((row) => row.id === id)?.family));
    assert.ok(families.size >= 3);
  });

  it("recommends 2 when only 2 models are VERIFIED_AVAILABLE", () => {
    const discovery = buildDiscovery(
      "openrusrouter",
      normalizeCatalogPayload([
        { id: "qwen/qwen3-coder", name: "Coder" },
        { id: "mistralai/mistral-large", name: "Mistral" },
        { id: "blocked/premium", name: "Premium" },
      ]).entries,
      [
        { id: "qwen/qwen3-coder", status: 200, body: "{}" },
        { id: "mistralai/mistral-large", status: 200, body: "{}" },
        { id: "blocked/premium", status: 403, body: "permission denied for model" },
      ],
    );
    assert.equal(availableModels(discovery.models).length, 2);
    assert.deepEqual(discovery.recommendedIds.sort(), ["mistralai/mistral-large", "qwen/qwen3-coder"].sort());
  });

  it("recommends up to 5 diverse verified models", () => {
    const entries = normalizeCatalogPayload(diverseCatalog).entries.filter((row) => !row.id.includes("tiny"));
    const discovery = buildDiscovery(
      "openrouter",
      entries,
      entries.map((row) => ({ id: row.id, status: 200, body: "{}" })),
    );
    assert.equal(discovery.recommendedIds.length, 5);
    assert.equal(new Set(discovery.recommendedIds.map((id) => discovery.models.find((row) => row.id === id)?.family)).size >= 4, true);
  });
});

describe("state safety", () => {
  it("provider switch rejects a catalog from another provider", () => {
    const nanoScan = buildDiscovery("nanogpt", normalizeCatalogPayload(diverseCatalog).entries, [
      { id: "qwen/qwen3-coder", status: 200, body: "{}" },
    ]);
    assert.match(sameProviderScan(nanoScan, "openrouter") ?? "", /NanoGPT/);
    assert.equal(sameProviderScan(nanoScan, "nanogpt", "subscription"), null);
  });

  it("drops stale selections that are not VERIFIED_AVAILABLE after a new scan", () => {
    const previous = ["openai/gpt-5", "qwen/qwen3-coder", "mistralai/mistral-large"];
    const current = buildDiscovery(
      "openrouter",
      normalizeCatalogPayload([
        { id: "qwen/qwen3-coder", name: "Coder" },
        { id: "mistralai/mistral-large", name: "Mistral" },
      ]).entries,
      [
        { id: "qwen/qwen3-coder", status: 200, body: "{}" },
        { id: "mistralai/mistral-large", status: 200, body: "{}" },
      ],
    );
    assert.deepEqual(pruneToAvailable(previous, current.models), ["qwen/qwen3-coder", "mistralai/mistral-large"]);
    assert.equal(previous.includes("openai/gpt-5"), true);
  });

  it("never mixes models from different providers inside one scan fingerprint", async () => {
    const nano = await discoverAccountWith(
      adapterFromTransport(
        mockTransport({
          provider: "nanogpt",
          billingMode: "subscription",
          catalog: { data: [{ id: "qwen/qwen3-coder" }, { id: "mistralai/mistral-large" }] },
        }),
      ),
      SECRET_NANO,
    );
    const or = await discoverAccountWith(
      adapterFromTransport(
        mockTransport({
          provider: "openrouter",
          catalog: { data: [{ id: "google/gemini-2.5-pro" }, { id: "meta-llama/llama-3.3-70b" }] },
        }),
      ),
      SECRET_OR,
    );
    assert.equal(nano.snapshot?.fingerprint, "nanogpt:subscription");
    assert.equal(or.snapshot?.fingerprint, "openrouter:default");
    assert.notEqual(nano.snapshot?.fingerprint, or.snapshot?.fingerprint);
    assert.match(sameProviderScan(nano.snapshot, "openrouter") ?? "", /not OpenRouter/);
  });

  it("keeps the synthesizer only when it remains selected and VERIFIED_AVAILABLE", () => {
    const catalog = buildDiscovery(
      "openrouter",
      normalizeCatalogPayload([
        { id: "qwen/qwen3-coder", name: "Coder" },
        { id: "mistralai/mistral-large", name: "Mistral" },
        { id: "google/gemini-2.5-pro", name: "Gemini" },
      ]).entries,
      [
        { id: "qwen/qwen3-coder", status: 200, body: "{}" },
        { id: "mistralai/mistral-large", status: 200, body: "{}" },
        { id: "google/gemini-2.5-pro", status: 200, body: "{}" },
      ],
    );
    const kept = applyDiscovery({
      attemptId: "a1",
      report: {
        ok: true,
        catalog,
        log: formatTestLog({
          result: "PASS",
          provider: "openrouter",
          connection: { status: "CONNECTED", detail: "ok" },
          catalog: { http_status: 200, model_count: 3 },
          probes: { performed: 3, ids: catalog.recommendedIds },
          access: { VERIFIED_AVAILABLE: 3, AVAILABLE: 3, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
          recommended: catalog.recommendedIds,
          selected: ["qwen/qwen3-coder", "mistralai/mistral-large"],
          warnings: [],
          extra: { mode: "default" },
        }),
      },
      previousIds: ["qwen/qwen3-coder", "mistralai/mistral-large"],
      previousSynth: "qwen/qwen3-coder",
      previousCatalog: null,
    });
    assert.equal(kept.synthesizerModel, "qwen/qwen3-coder");
    assert.equal(kept.selectedIds.includes("qwen/qwen3-coder"), true);
    assert.equal(isVerifiedAvailable(catalog.models.find((row) => row.id === kept.synthesizerModel)?.access), true);

    const dropped = applyDiscovery({
      attemptId: "a2",
      report: {
        ok: true,
        catalog,
        log: formatTestLog({
          result: "PASS",
          provider: "openrouter",
          connection: { status: "CONNECTED", detail: "ok" },
          catalog: { http_status: 200, model_count: 3 },
          probes: { performed: 3, ids: [] },
          access: { VERIFIED_AVAILABLE: 3 },
          recommended: catalog.recommendedIds,
          selected: selectionAfterScan(["mistralai/mistral-large"], catalog),
          warnings: [],
        }),
      },
      previousIds: ["mistralai/mistral-large"],
      previousSynth: "blocked/gone",
      previousCatalog: null,
    });
    assert.equal(dropped.synthesizerModel, "");
    assert.equal(dropped.selectedIds.includes("blocked/gone"), false);
  });
});

describe("access classification on the adapter", () => {
  it("catalog presence is never enough", () => {
    const adapter = adapterFromTransport(mockTransport({ provider: "nanogpt", billingMode: "subscription", catalog: {} }));
    assert.equal(adapter.classifyAccess({ id: "x", status: 200, body: "{}" }, true), "VERIFIED_AVAILABLE");
    assert.equal(adapter.classifyAccess({ id: "x", status: 403, body: "not included in your subscription" }, true), "NOT_INCLUDED");
    assert.equal(adapter.classifyAccess({ id: "x", status: 404, body: "model not found" }, true), "UNAVAILABLE");
    assert.equal(adapter.classifyVerified({ id: "x", status: 200 }), "VERIFIED_AVAILABLE");
    assert.equal(classifyProbe({ id: "x", status: 200, body: "{}" }, true), "VERIFIED_AVAILABLE");
  });

  it("verifySelectedWith requires every selected model VERIFIED_AVAILABLE", async () => {
    const transport = mockTransport({
      provider: "openrouter",
      catalog: { data: [{ id: "qwen/qwen3-coder" }] },
      ping: (id) => (id.includes("premium") ? { status: 403, body: "no access to this model" } : { status: 200, body: "{}" }),
    });
    const denied = await verifySelectedWith(adapterFromTransport(transport), SECRET_OR, [
      "qwen/qwen3-coder",
      "openai/gpt-premium-only",
    ]);
    assert.equal(denied.ok, false);
    assert.equal(denied.verified?.find((row) => row.id === "qwen/qwen3-coder")?.access, "VERIFIED_AVAILABLE");
    assert.equal(denied.verified?.find((row) => row.id === "openai/gpt-premium-only")?.access, "NOT_INCLUDED");
  });
});

describe("adapter capabilities", () => {
  it("derives reasoning/coding/research from catalog metadata, not vendor names", () => {
    const adapter = adapterFromTransport(mockTransport({ provider: "openrouter", catalog: [] }));
    const caps = adapter.getCapabilities({
      id: "local/architect-thinker",
      name: "Architect Thinker",
      contextLength: 200000,
      ownedBy: "",
      description: "code reasoning research",
      reasoningHint: true,
    });
    assert.equal(caps.reasoning, true);
    assert.equal(caps.coding, true);
    assert.equal(caps.longContext, true);
    assert.equal(caps.research, true);
  });
});
