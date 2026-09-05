import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessBlocksRun,
  availableModels,
  buildDiscovery,
  classifyProbe,
  classifyVerified,
  currentConnectionView,
  familyOf,
  isProviderBrandModel,
  isVerifiedAvailable,
  normalizeCatalogPayload,
  parseCatalogBody,
  pickDiverse,
  pickProbeTargets,
  pruneToAvailable,
  scoreModel,
} from "./discover.ts";
import { discoverAccountWith, listCatalogWith, preflightWith, verifySelectedWith, type ProviderTransport } from "./provider-discover.ts";
import { formatTestLog } from "./test-log.ts";
import { containsSecret } from "./provider-error.ts";
import { assertAvailableSelection, assertCouncilSelection, attemptLimit, expectedSuccessfulCalls, assignRoles, membersFromIds, MIN_COUNCIL_MEMBERS } from "./members.ts";

const nanoCatalog = {
  data: [
    { id: "openai/gpt-5", name: "GPT-5", context_length: 200000 },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000 },
    { id: "x-ai/grok-4", name: "Grok 4", context_length: 128000 },
    { id: "perplexity/sonar-pro", name: "Sonar Pro", context_length: 127000 },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1", context_length: 64000 },
    { id: "moonshotai/kimi-k2", name: "Kimi K2", context_length: 128000 },
    { id: "openai/gpt-5-premium-only", name: "GPT-5 Premium", context_length: 200000 },
    { id: "mistralai/mistral-tiny", name: "Tiny", context_length: 8000 },
  ],
};

describe("catalog parsing and families", () => {
  it("detects Perplexity, DeepSeek, and Kimi families", () => {
    assert.equal(familyOf("perplexity/sonar-pro"), "perplexity");
    assert.equal(familyOf("deepseek/deepseek-chat"), "deepseek");
    assert.equal(familyOf("moonshotai/kimi-k2"), "kimi");
    assert.equal(familyOf("x-ai/grok-4"), "xai");
    assert.equal(familyOf("anthropic/claude-opus-4"), "anthropic");
  });

  it("parses an OpenAI-style catalog", () => {
    const entries = parseCatalogBody(nanoCatalog);
    assert.equal(entries.length, 8);
    assert.equal(entries[0]?.id, "openai/gpt-5");
    assert.equal(entries[0]?.contextLength, 200000);
  });
});

describe("access classification", () => {
  it("does not treat catalog presence as usable access", () => {
    const entries = parseCatalogBody(nanoCatalog);
    const discovery = buildDiscovery(
      "nanogpt",
      entries,
      [
        { id: "openai/gpt-5", status: 200, body: "{}" },
        { id: "openai/gpt-5-premium-only", status: 403, body: "model not included in your subscription" },
        { id: "mistralai/mistral-tiny", status: 404, body: "model not found" },
      ],
    );
    const premium = discovery.models.find((row) => row.id === "openai/gpt-5-premium-only");
    const tiny = discovery.models.find((row) => row.id === "mistralai/mistral-tiny");
    const gpt = discovery.models.find((row) => row.id === "openai/gpt-5");
    const unprobed = discovery.models.find((row) => row.id === "perplexity/sonar-pro");
    assert.equal(gpt?.access, "AVAILABLE");
    assert.equal(premium?.access, "NOT_INCLUDED");
    assert.equal(tiny?.access, "UNAVAILABLE");
    assert.equal(unprobed?.access, "UNKNOWN");
    assert.equal(unprobed?.probed, false);
    assert.equal(accessBlocksRun("NOT_INCLUDED"), true);
    assert.equal(accessBlocksRun("UNAVAILABLE"), true);
    assert.equal(accessBlocksRun("AVAILABLE"), false);
  });

  it("classifies a catalog-visible but call-denied model as NOT_INCLUDED", () => {
    assert.equal(
      classifyProbe({ id: "x", status: 403, body: "You do not have access to this model" }, true),
      "NOT_INCLUDED",
    );
    assert.equal(classifyProbe({ id: "x", status: 404, body: "model not found" }, true), "UNAVAILABLE");
    assert.equal(classifyProbe({ id: "x", status: 200, body: "{}" }, true), "AVAILABLE");
    assert.equal(classifyProbe({ id: "x", status: 429, body: "rate" }, true), "UNKNOWN");
  });

  it("marks a selected model missing from the catalog as UNAVAILABLE", () => {
    const discovery = buildDiscovery("nanogpt", parseCatalogBody(nanoCatalog), [{ id: "missing/vanished", status: 200, body: "{}" }], ["missing/vanished"]);
    const row = discovery.models.find((item) => item.id === "missing/vanished");
    assert.equal(row?.access, "UNAVAILABLE");
    assert.equal(discovery.recommendedIds.includes("missing/vanished"), false);
  });
});

describe("recommendation", () => {
  it("prefers diverse families and does not require Grok", () => {
    const entries = parseCatalogBody({
      data: [
        { id: "anthropic/claude-opus-4", name: "Opus" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "perplexity/sonar-reasoning", name: "Sonar" },
        { id: "deepseek/deepseek-r1", name: "R1" },
        { id: "moonshotai/kimi-k2", name: "Kimi" },
      ],
    });
    const discovery = buildDiscovery(
      "openrouter",
      entries,
      entries.map((row) => ({ id: row.id, status: 200, body: "{}" })),
    );
    assert.ok(discovery.recommendedIds.length >= 3);
    assert.ok(discovery.recommendedIds.length <= 5);
    const families = discovery.recommendedIds.map((id) => familyOf(id));
    assert.ok(new Set(families).size >= 3);
    assert.equal(discovery.recommendedIds.includes("x-ai/grok-4"), false);
  });

  it("scores reasoning models above tiny/lite variants", () => {
    assert.ok(
      scoreModel({ id: "anthropic/claude-opus-4", name: "Opus", contextLength: 200000, ownedBy: "" }) >
        scoreModel({ id: "anthropic/claude-haiku", name: "Haiku", contextLength: 8000, ownedBy: "" }),
    );
  });

  it("caps probe targets and always includes the current selection", () => {
    const entries = parseCatalogBody(nanoCatalog);
    const targets = pickProbeTargets(entries, ["moonshotai/kimi-k2"], 4);
    assert.ok(targets.includes("moonshotai/kimi-k2"));
    assert.ok(targets.length <= 4);
  });
});

describe("council membership", () => {
  it("requires 2–5 unique models", () => {
    assert.match(assertCouncilSelection(["only-one"]) ?? "", /at least 2/);
    assert.equal(assertCouncilSelection(["a", "b"]), null);
    assert.match(assertCouncilSelection(["a", "b", "c", "d", "e", "f"]) ?? "", /at most 5/);
  });

  it("assigns dynamic roles without GPT/Grok/Claude identities", () => {
    const members = assignRoles([
      { id: "anthropic/claude-opus-4", name: "Opus", family: "anthropic", score: 100, reasoning: true },
      { id: "perplexity/sonar-pro", name: "Sonar", family: "perplexity", score: 90 },
      { id: "deepseek/deepseek-r1", name: "R1", family: "deepseek", score: 88, reasoning: true },
    ]);
    assert.equal(members.length, 3);
    assert.equal(members[0]?.role, "LEAD_REASONER");
    assert.ok(members.every((row) => row.role !== ("GPT" as typeof row.role)));
    assert.deepEqual(
      members.map((row) => row.modelId).sort(),
      ["anthropic/claude-opus-4", "deepseek/deepseek-r1", "perplexity/sonar-pro"].sort(),
    );
  });

  it("adapts expected calls to 2 / 3 / 5 members", () => {
    assert.equal(expectedSuccessfulCalls(2), 5);
    assert.equal(expectedSuccessfulCalls(3), 7);
    assert.equal(expectedSuccessfulCalls(5), 11);
    assert.equal(attemptLimit(2), 9);
    assert.equal(attemptLimit(3), 12);
    assert.equal(attemptLimit(5), 18);
    assert.equal(MIN_COUNCIL_MEMBERS, 2);
  });

  it("builds members from selected ids using catalog metadata", () => {
    const discovery = buildDiscovery(
      "nanogpt",
      parseCatalogBody(nanoCatalog),
      [
        { id: "openai/gpt-5", status: 200 },
        { id: "deepseek/deepseek-r1", status: 200 },
      ],
    );
    const members = membersFromIds(["openai/gpt-5", "deepseek/deepseek-r1"], discovery.models);
    assert.equal(members.length, 2);
    assert.ok(members.some((row) => row.modelId === "openai/gpt-5"));
    assert.ok(members.some((row) => row.modelId === "deepseek/deepseek-r1"));
  });

  it("never treats a secret as part of discovery metadata", () => {
    const discovery = buildDiscovery("nanogpt", parseCatalogBody(nanoCatalog), [], []);
    const blob = JSON.stringify(discovery);
    assert.equal(/sk-(?:or|nano)-/i.test(blob), false);
    assert.equal(/Bearer /i.test(blob), false);
  });
});

describe("diversity picker", () => {
  it("does not fill five slots with the same family when others exist", () => {
    const models = [
      { id: "anthropic/a", name: "A", family: "anthropic", access: "AVAILABLE" as const, recommendedRole: null, contextTokens: null, reasoning: true, score: 99, probed: true },
      { id: "anthropic/b", name: "B", family: "anthropic", access: "AVAILABLE" as const, recommendedRole: null, contextTokens: null, reasoning: true, score: 98, probed: true },
      { id: "openai/c", name: "C", family: "openai", access: "AVAILABLE" as const, recommendedRole: null, contextTokens: null, reasoning: true, score: 97, probed: true },
      { id: "deepseek/d", name: "D", family: "deepseek", access: "AVAILABLE" as const, recommendedRole: null, contextTokens: null, reasoning: true, score: 96, probed: true },
    ];
    const picked = pickDiverse(models, 3);
    assert.equal(new Set(picked.map((row) => row.family)).size, 3);
  });
});

function dm(
  id: string,
  access: "AVAILABLE" | "UNAVAILABLE" | "NOT_INCLUDED" | "UNKNOWN",
  extras: Partial<{ family: string; score: number; name: string }> = {},
) {
  return {
    id,
    name: extras.name ?? id,
    family: extras.family ?? familyOf(id),
    access,
    recommendedRole: null,
    contextTokens: null,
    reasoning: true,
    score: extras.score ?? 80,
    probed: access !== "UNKNOWN",
  };
}

describe("provider is not a model", () => {
  it("never treats NanoGPT or OpenRouter as AI models", () => {
    assert.equal(isProviderBrandModel("NanoGPT"), true);
    assert.equal(isProviderBrandModel("nanogpt"), true);
    assert.equal(isProviderBrandModel("openrouter"), true);
    assert.equal(isProviderBrandModel("OpenRouter"), true);
    assert.equal(isProviderBrandModel("openrusrouter"), true);
    assert.equal(isProviderBrandModel("openai/gpt-5"), false);
    assert.equal(isProviderBrandModel("x-ai/grok-4.6"), false);
  });

  it("drops provider brand ids from the catalog", () => {
    const entries = parseCatalogBody({
      data: [
        { id: "NanoGPT", name: "NanoGPT" },
        { id: "openrouter", name: "OpenRouter" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
      ],
    });
    assert.deepEqual(
      entries.map((row) => row.id),
      ["anthropic/claude-sonnet-4"],
    );
  });
});

describe("AVAILABLE-only recommendations and selection", () => {
  it("does not recommend or select Grok 4.6 when it is absent from the catalog", () => {
    const entries = parseCatalogBody({
      data: [
        { id: "anthropic/claude-sonnet-4", name: "Sonnet", context_length: 200000 },
        { id: "openai/gpt-5", name: "GPT-5", context_length: 200000 },
        { id: "deepseek/deepseek-r1", name: "R1", context_length: 64000 },
      ],
    });
    const discovery = buildDiscovery(
      "nanogpt",
      entries,
      entries.map((row) => ({ id: row.id, status: 200, body: "{}" })),
      ["x-ai/grok-4.6"],
    );
    assert.equal(discovery.models.some((row) => row.id === "x-ai/grok-4.6" && row.access === "AVAILABLE"), false);
    assert.equal(discovery.recommendedIds.includes("x-ai/grok-4.6"), false);
    assert.deepEqual(pruneToAvailable(["x-ai/grok-4.6", "openai/gpt-5"], discovery.models), ["openai/gpt-5"]);
    const members = membersFromIds(["x-ai/grok-4.6", "openai/gpt-5", "deepseek/deepseek-r1"], discovery.models);
    assert.equal(members.some((row) => row.modelId.includes("grok")), false);
    assert.equal(assertAvailableSelection(["x-ai/grok-4.6", "openai/gpt-5"], discovery.models)?.includes("MODEL_UNAVAILABLE"), true);
  });

  it("removes a stale Grok selection from a previous scan", () => {
    const previous = ["x-ai/grok-4.6", "openai/gpt-5", "anthropic/claude-sonnet-4"];
    const current = [
      dm("openai/gpt-5", "AVAILABLE", { family: "openai", score: 90 }),
      dm("anthropic/claude-sonnet-4", "AVAILABLE", { family: "anthropic", score: 92 }),
      dm("deepseek/deepseek-r1", "AVAILABLE", { family: "deepseek", score: 85 }),
    ];
    assert.deepEqual(pruneToAvailable(previous, current), ["openai/gpt-5", "anthropic/claude-sonnet-4"]);
  });

  it("lists DeepSeek, Kimi, and Perplexity only when they were discovered", () => {
    const withThem = parseCatalogBody({
      data: [
        { id: "deepseek/deepseek-r1", name: "R1" },
        { id: "moonshotai/kimi-k2", name: "Kimi" },
        { id: "perplexity/sonar-pro", name: "Sonar" },
      ],
    });
    assert.equal(withThem.some((row) => familyOf(row.id) === "deepseek"), true);
    assert.equal(withThem.some((row) => familyOf(row.id) === "kimi"), true);
    assert.equal(withThem.some((row) => familyOf(row.id) === "perplexity"), true);
    const without = parseCatalogBody({
      data: [{ id: "openai/gpt-5", name: "GPT-5" }, { id: "anthropic/claude-sonnet-4", name: "Sonnet" }],
    });
    assert.equal(without.some((row) => /deepseek|kimi|perplexity|grok/i.test(row.id)), false);
  });

  it("recommends only AVAILABLE models, 3–5 when that many exist", () => {
    const entries = parseCatalogBody({
      data: [
        { id: "anthropic/claude-opus-4", name: "Opus" },
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "perplexity/sonar-reasoning", name: "Sonar" },
        { id: "deepseek/deepseek-r1", name: "R1" },
        { id: "moonshotai/kimi-k2", name: "Kimi" },
        { id: "google/gemini-2.5-pro", name: "Gemini" },
      ],
    });
    const discovery = buildDiscovery(
      "nanogpt",
      entries,
      entries.map((row) => ({ id: row.id, status: 200, body: "{}" })),
    );
    assert.ok(discovery.recommendedIds.length >= 3);
    assert.ok(discovery.recommendedIds.length <= 5);
    for (const id of discovery.recommendedIds) {
      assert.equal(discovery.models.find((row) => row.id === id)?.access, "AVAILABLE");
    }
  });

  it("recommends 2 when only 2 models are AVAILABLE", () => {
    const discovery = buildDiscovery(
      "nanogpt",
      parseCatalogBody({
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
          { id: "openai/gpt-5", name: "GPT-5" },
          { id: "x-ai/grok-4.6", name: "Grok 4.6" },
        ],
      }),
      [
        { id: "anthropic/claude-sonnet-4", status: 200, body: "{}" },
        { id: "openai/gpt-5", status: 200, body: "{}" },
        { id: "x-ai/grok-4.6", status: 403, body: "model not included in your subscription" },
      ],
    );
    assert.deepEqual(discovery.recommendedIds.sort(), ["anthropic/claude-sonnet-4", "openai/gpt-5"].sort());
    assert.equal(availableModels(discovery.models).length, 2);
    assert.equal(discovery.recommendedIds.includes("x-ai/grok-4.6"), false);
  });

  it("does not recommend UNKNOWN unprobed catalog rows", () => {
    const discovery = buildDiscovery("nanogpt", parseCatalogBody(nanoCatalog), [
      { id: "openai/gpt-5", status: 200, body: "{}" },
      { id: "anthropic/claude-sonnet-4", status: 200, body: "{}" },
    ]);
    for (const id of discovery.recommendedIds) {
      assert.equal(discovery.models.find((row) => row.id === id)?.access, "AVAILABLE");
    }
    const unprobed = discovery.models.filter((row) => row.access === "UNKNOWN");
    assert.ok(unprobed.length > 0);
    assert.ok(unprobed.every((row) => !discovery.recommendedIds.includes(row.id)));
  });
});

describe("sanitized test log", () => {
  const secret = "sk-nano-THISISASECRETKEYVALUE99";

  it("always includes required fields for PASS and never the API key", () => {
    const log = formatTestLog(
      {
        result: "PASS",
        time: "2026-09-05T17:00:00.000Z",
        provider: "nanogpt",
        connection: { status: "CONNECTED", detail: "NanoGPT connected" },
        catalog: {
          http_status: 200,
          model_count: 4,
          latency_ms: 12,
          response_shape: "openai_data_array",
          parse: { ok: true, meta: { json: true, root_type: "object", keys: ["data"], data_type: "array", row_count: 4 } },
        },
        probes: { performed: 2, ids: ["openai/gpt-5", "anthropic/claude-sonnet-4"] },
        access: { AVAILABLE: 2, NOT_INCLUDED: 1, UNAVAILABLE: 0, UNKNOWN: 1 },
        recommended: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
        selected: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
        warnings: [],
        extra: { apiKey: secret, Authorization: `Bearer ${secret}` },
      },
      secret,
    );
    assert.match(log, /"result": "PASS"/);
    assert.match(log, /"provider": "nanogpt"/);
    assert.match(log, /"status": "CONNECTED"/);
    assert.match(log, /"http_status": 200/);
    assert.match(log, /"model_count": 4/);
    assert.match(log, /"AVAILABLE": 2/);
    assert.match(log, /"response_shape": "openai_data_array"/);
    assert.equal(log.includes(secret), false);
    assert.equal(containsSecret(log), false);
    assert.equal(/Bearer /i.test(log), false);
    assert.equal(/apiKey/i.test(log), false);
  });

  it("always includes required fields for FAIL and never the API key", () => {
    const log = formatTestLog(
      {
        result: "FAIL",
        provider: "openrouter",
        connection: { status: "FAILED", detail: "key rejected" },
        catalog: { http_status: 401, model_count: 0, response_shape: "none" },
        probes: { performed: 0, ids: [] },
        access: { AVAILABLE: 0, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
        recommended: [],
        selected: [],
        warnings: [],
        error: `Unauthorized for ${secret}`,
      },
      secret,
    );
    assert.match(log, /"result": "FAIL"/);
    assert.match(log, /"status": "FAILED"/);
    assert.equal(log.includes(secret), false);
    assert.equal(containsSecret(log), false);
  });
});

describe("discoverAccountWith scan", () => {
  const secret = "sk-nano-THISISASECRETKEYVALUE99";

  function transport(catalog: unknown, denied: string[] = []): ProviderTransport {
    return {
      provider: "nanogpt",
      label: "NanoGPT",
      creditMessage: "Add NanoGPT credits.",
      listModels: async () => ({ status: 200, body: JSON.stringify(catalog), latencyMs: 9 }),
      pingModel: async (_key, id) => {
        if (denied.includes(id)) return { status: 403, body: "model not included in your subscription" };
        return { status: 200, body: "{}" };
      },
    };
  }

  it("CONNECTS, drops stale Grok, never treats NanoGPT as a model, and logs PASS without secrets", async () => {
    const catalog = {
      data: [
        { id: "NanoGPT", name: "NanoGPT" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "deepseek/deepseek-r1", name: "R1" },
      ],
    };
    const result = await discoverAccountWith(transport(catalog), secret, [
      "x-ai/grok-4.6",
      "openai/gpt-5",
      "NanoGPT",
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot?.models.some((row) => /nanogpt/i.test(row.id)), false);
    assert.equal(result.snapshot?.recommendedIds.includes("x-ai/grok-4.6"), false);
    assert.equal(result.snapshot?.models.some((row) => row.id === "x-ai/grok-4.6" && row.access === "AVAILABLE"), false);
    assert.match(result.log, /"result": "PASS"/);
    assert.match(result.log, /"status": "CONNECTED"/);
    assert.match(result.log, /Dropped stale selection x-ai\/grok-4.6/);
    assert.equal(result.log.includes(secret), false);
    assert.equal(containsSecret(result.log), false);
    const parsed = JSON.parse(result.log) as { selected: string[]; recommended: string[] };
    assert.equal(parsed.selected.includes("x-ai/grok-4.6"), false);
    assert.equal(parsed.selected.includes("NanoGPT"), false);
    assert.ok(parsed.recommended.length >= 2);
    assert.ok(parsed.recommended.length <= 5);
  });

  it("writes a FAIL log when the catalog request is rejected", async () => {
    const bad: ProviderTransport = {
      provider: "nanogpt",
      label: "NanoGPT",
      creditMessage: "Add NanoGPT credits.",
      listModels: async () => ({ status: 401, body: `invalid key ${secret}`, latencyMs: 4 }),
      pingModel: async () => ({ status: 0, body: "" }),
    };
    const result = await discoverAccountWith(bad, secret, []);
    assert.equal(result.ok, false);
    assert.match(result.log, /"result": "FAIL"/);
    assert.match(result.log, /"status": "FAILED"/);
    assert.equal(result.log.includes(secret), false);
    assert.equal(containsSecret(result.log), false);
  });

  it("preflight still blocks a paid run when a selected model is not AVAILABLE", async () => {
    const catalog = {
      data: [
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
      ],
    };
    const report = await preflightWith(transport(catalog), {
      apiKey: secret,
      selectedIds: ["openai/gpt-5", "x-ai/grok-4.6"],
    });
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /MODEL_UNAVAILABLE/);
    assert.match(report.error ?? "", /x-ai\/grok-4.6/);
    assert.equal(report.catalog?.recommendedIds.includes("x-ai/grok-4.6"), false);
  });
});

describe("catalog normalize", () => {
  it("parses a NanoGPT OpenAI { data: [...] } catalog", () => {
    const norm = normalizeCatalogPayload(nanoCatalog);
    assert.equal(norm.ok, true);
    assert.equal(norm.shape, "openai_data_array");
    assert.equal(norm.entries.length, 8);
    assert.equal(norm.meta.root_type, "object");
    assert.equal(norm.meta.data_type, "array");
    assert.equal(norm.entries.some((row) => /nanogpt/i.test(row.id)), false);
  });

  it("parses a direct-array catalog", () => {
    const norm = normalizeCatalogPayload([
      { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
      { id: "openai/gpt-5", name: "GPT-5" },
    ]);
    assert.equal(norm.ok, true);
    assert.equal(norm.shape, "direct_array");
    assert.equal(norm.entries.length, 2);
  });

  it("returns CATALOG_PARSE_ERROR for malformed catalogs without throwing", () => {
    const shapes = [
      { object: "list", data: { id: "not-an-array" } },
      { models: [{ id: "openai/gpt-5" }] },
      { data: null },
      "openai/gpt-5",
      12,
      { data: { map: true, id: "x" } },
    ];
    for (const payload of shapes) {
      const norm = normalizeCatalogPayload(payload);
      assert.equal(norm.ok, false, JSON.stringify(payload));
      assert.equal(norm.code, "CATALOG_PARSE_ERROR");
      assert.equal(norm.entries.length, 0);
      assert.match(norm.error ?? "", /CATALOG_PARSE_ERROR/);
      assert.ok(norm.meta.root_type);
    }
    const empty = normalizeCatalogPayload(null);
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "CATALOG_PARSE_ERROR");
    const invalid = normalizeCatalogPayload(undefined);
    assert.equal(invalid.shape, "invalid_json");
  });

  it("never treats NanoGPT as a model even when the catalog row is the provider name", () => {
    const norm = normalizeCatalogPayload({
      data: [
        { id: "NanoGPT", name: "NanoGPT" },
        { id: "openai/gpt-5", name: "GPT-5" },
      ],
    });
    assert.deepEqual(
      norm.entries.map((row) => row.id),
      ["openai/gpt-5"],
    );
  });
});

describe("current connection view", () => {
  it("shows current results after a successful test", () => {
    const catalog = buildDiscovery(
      "nanogpt",
      parseCatalogBody(nanoCatalog),
      [
        { id: "openai/gpt-5", status: 200, body: "{}" },
        { id: "anthropic/claude-sonnet-4", status: 200, body: "{}" },
      ],
    );
    const view = currentConnectionView(true, catalog);
    assert.equal(view.status, "CONNECTED");
    assert.equal(view.discovered, catalog.models.length);
    assert.equal(view.available, availableModels(catalog.models).length);
    assert.equal(view.stale, null);
    assert.ok(view.catalog);
  });

  it("failed refresh after a previous 616/6 scan never shows those counts as current", () => {
    const entries = Array.from({ length: 616 }, (_, i) => ({
      id: `model/${i}`,
      name: `M${i}`,
      contextLength: 8000,
      ownedBy: i < 6 ? "openai" : "other",
    }));
    const probes = Array.from({ length: 6 }, (_, i) => ({ id: `model/${i}`, status: 200, body: "{}" }));
    const previous = buildDiscovery("nanogpt", entries, probes);
    assert.equal(previous.models.length, 616);
    assert.equal(availableModels(previous.models).length, 6);
    const view = currentConnectionView(false, previous);
    assert.equal(view.status, "FAILED");
    assert.equal(view.discovered, 0);
    assert.equal(view.available, 0);
    assert.equal(view.catalog, null);
    assert.equal(view.stale?.models.length, 616);
    assert.equal(availableModels(view.stale?.models ?? []).length, 6);
  });
});

describe("discoverAccountWith catalog parse and auth", () => {
  const secret = "sk-nano-THISISASECRETKEYVALUE99";

  function transport(
    catalog: unknown,
    ping: (id: string) => { status: number; body: string } = () => ({ status: 200, body: "{}" }),
  ): ProviderTransport {
    return {
      provider: "nanogpt",
      label: "NanoGPT",
      creditMessage: "Add NanoGPT credits.",
      listModels: async () => ({ status: 200, body: JSON.stringify(catalog), latencyMs: 9 }),
      pingModel: async (_key, id) => ping(id),
    };
  }

  it("CONNECTS a valid NanoGPT { data: [...] } catalog and records response shape", async () => {
    const result = await discoverAccountWith(
      transport({
        object: "list",
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
          { id: "openai/gpt-5", name: "GPT-5" },
          { id: "deepseek/deepseek-r1", name: "R1" },
        ],
      }),
      secret,
    );
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.catalogShape, "openai_data_array");
    assert.match(result.log, /"result": "PASS"/);
    assert.match(result.log, /"status": "CONNECTED"/);
    assert.match(result.log, /"response_shape": "openai_data_array"/);
    assert.match(result.log, /"authenticated": true/);
    assert.equal(result.log.includes(secret), false);
    assert.equal(containsSecret(result.log), false);
  });

  it("CONNECTS a direct-array catalog", async () => {
    const result = await discoverAccountWith(
      transport([
        { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
        { id: "openai/gpt-5", name: "GPT-5" },
      ]),
      secret,
    );
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.catalogShape, "direct_array");
    assert.match(result.log, /"response_shape": "direct_array"/);
  });

  it("malformed catalog returns CATALOG_PARSE_ERROR, not CONNECTED, and does not crash", async () => {
    const result = await discoverAccountWith(transport({ object: "list", data: { id: "x" } }), secret);
    assert.equal(result.ok, false);
    assert.equal(result.snapshot, null);
    assert.match(result.error ?? "", /CATALOG_PARSE_ERROR/);
    assert.match(result.log, /"result": "FAIL"/);
    assert.match(result.log, /"status": "FAILED"/);
    assert.match(result.log, /CATALOG_PARSE_ERROR/);
    assert.match(result.log, /"response_shape": "unsupported"/);
    assert.match(result.log, /"root_type": "object"/);
    assert.match(result.log, /"data_type": "object"/);
    assert.equal(result.log.includes(secret), false);
  });

  it("invalid key is FAILED, not CONNECTED", async () => {
    const bad: ProviderTransport = {
      provider: "nanogpt",
      label: "NanoGPT",
      creditMessage: "Add NanoGPT credits.",
      listModels: async () => ({ status: 401, body: `invalid key ${secret}`, latencyMs: 4 }),
      pingModel: async () => ({ status: 0, body: "" }),
    };
    const result = await discoverAccountWith(bad, secret, []);
    assert.equal(result.ok, false);
    assert.match(result.log, /"result": "FAIL"/);
    assert.match(result.log, /"status": "FAILED"/);
    assert.equal(/"status": "CONNECTED"/.test(result.log), false);
    assert.equal(result.log.includes(secret), false);
  });

  it("catalog HTTP 200 with probe 401 is FAILED, not CONNECTED", async () => {
    const result = await discoverAccountWith(
      transport(
        {
          data: [
            { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
            { id: "openai/gpt-5", name: "GPT-5" },
          ],
        },
        () => ({ status: 401, body: "unauthorized" }),
      ),
      secret,
    );
    assert.equal(result.ok, false);
    assert.equal(result.snapshot, null);
    assert.equal(/"status": "CONNECTED"/.test(result.log), false);
    assert.match(result.log, /"status": "FAILED"/);
  });

  it("catalog-visible but NOT_INCLUDED model is not AVAILABLE", async () => {
    const result = await discoverAccountWith(
      transport(
        {
          data: [
            { id: "openai/gpt-5", name: "GPT-5" },
            { id: "openai/gpt-5-premium-only", name: "Premium" },
          ],
        },
        (id) =>
          id.includes("premium")
            ? { status: 403, body: "model not included in your subscription" }
            : { status: 200, body: "{}" },
      ),
      secret,
      ["openai/gpt-5", "openai/gpt-5-premium-only"],
    );
    assert.equal(result.ok, true);
    const premium = result.snapshot?.models.find((row) => row.id === "openai/gpt-5-premium-only");
    assert.equal(premium?.access, "NOT_INCLUDED");
    assert.equal(result.snapshot?.recommendedIds.includes("openai/gpt-5-premium-only"), false);
  });

  it("does not invent Grok when the catalog has none", async () => {
    const result = await discoverAccountWith(
      transport({
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
          { id: "openai/gpt-5", name: "GPT-5" },
        ],
      }),
      secret,
      ["x-ai/grok-4.6"],
    );
    assert.equal(result.ok, true);
    assert.equal(result.snapshot?.recommendedIds.some((id) => /grok/i.test(id)), false);
    assert.equal(result.snapshot?.models.some((row) => row.id === "x-ai/grok-4.6" && row.access === "AVAILABLE"), false);
  });

  it("PASS log includes catalog shape and survives as persisted text without the secret", async () => {
    const result = await discoverAccountWith(
      transport({
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Sonnet" },
          { id: "openai/gpt-5", name: "GPT-5" },
        ],
      }),
      secret,
    );
    const stored = result.log;
    const parsed = JSON.parse(stored) as {
      result: string;
      catalog: { response_shape: string; parse: { ok: boolean } };
      connection: { status: string };
    };
    assert.equal(parsed.result, "PASS");
    assert.equal(parsed.connection.status, "CONNECTED");
    assert.equal(parsed.catalog.response_shape, "openai_data_array");
    assert.equal(parsed.catalog.parse.ok, true);
    assert.equal(stored.includes(secret), false);
  });

  it("listCatalogWith fails closed on unsupported shape", async () => {
    const listed = await listCatalogWith(transport({ data: { id: "x" } }), secret);
    assert.equal(listed.ok, false);
    if (listed.ok) throw new Error("expected parse failure");
    assert.equal(listed.code, "CATALOG_PARSE_ERROR");
  });
});

describe("verified access vs catalog scan", () => {
  it("maps a live 200 probe to VERIFIED_AVAILABLE, 403 subscription-denied to NOT_INCLUDED", () => {
    assert.equal(classifyVerified({ id: "openai/gpt-5", status: 200, body: "{}" }), "VERIFIED_AVAILABLE");
    assert.equal(
      classifyVerified({ id: "openai/gpt-5-premium-only", status: 403, body: "model not included in your subscription" }),
      "NOT_INCLUDED",
    );
    assert.equal(classifyVerified({ id: "missing/vanished", status: 404, body: "model not found" }), "UNAVAILABLE");
    assert.equal(classifyVerified({ id: "x", status: 429, body: "rate" }), "UNKNOWN");
    assert.equal(isVerifiedAvailable("VERIFIED_AVAILABLE"), true);
    assert.equal(isVerifiedAvailable("AVAILABLE"), true);
    assert.equal(isVerifiedAvailable("NOT_INCLUDED"), false);
    assert.equal(isVerifiedAvailable("UNAVAILABLE"), false);
    assert.equal(isVerifiedAvailable("UNKNOWN"), false);
  });

  it("verifySelectedWith probes every selected model and does not treat catalog presence as access", async () => {
    const pings: string[] = [];
    const transport: ProviderTransport = {
      provider: "nanogpt",
      label: "NanoGPT",
      creditMessage: "Add NanoGPT credits.",
      listModels: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "openai/gpt-5" }] }), latencyMs: 1 }),
      pingModel: async (_key, id) => {
        pings.push(id);
        if (id.includes("premium")) return { status: 403, body: "not included in your subscription" };
        if (id.includes("missing")) return { status: 404, body: "model not found" };
        return { status: 200, body: "{}" };
      },
    };
    const denied = await verifySelectedWith(transport, "sk-nano-THISISASECRETKEYVALUE99", [
      "openai/gpt-5",
      "openai/gpt-5-premium-only",
      "missing/vanished",
    ]);
    assert.equal(denied.ok, false);
    assert.deepEqual(pings.sort(), ["missing/vanished", "openai/gpt-5", "openai/gpt-5-premium-only"].sort());
    assert.equal(denied.verified?.find((row) => row.id === "openai/gpt-5")?.access, "VERIFIED_AVAILABLE");
    assert.equal(denied.verified?.find((row) => row.id === "openai/gpt-5-premium-only")?.access, "NOT_INCLUDED");
    assert.equal(denied.verified?.find((row) => row.id === "missing/vanished")?.access, "UNAVAILABLE");
    assert.match(denied.error ?? "", /NOT_INCLUDED/);
    assert.match(denied.error ?? "", /VERIFIED_AVAILABLE/);
    const ok = await verifySelectedWith(transport, "sk-nano-THISISASECRETKEYVALUE99", ["openai/gpt-5", "anthropic/claude-sonnet-4"]);
    assert.equal(ok.ok, true);
    assert.ok(ok.verified?.every((row) => row.access === "VERIFIED_AVAILABLE"));
  });
});
