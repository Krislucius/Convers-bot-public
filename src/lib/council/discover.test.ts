import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessBlocksRun,
  buildDiscovery,
  classifyProbe,
  familyOf,
  parseCatalogBody,
  pickDiverse,
  pickProbeTargets,
  scoreModel,
} from "./discover.ts";
import { assignRoles, assertCouncilSelection, attemptLimit, expectedSuccessfulCalls, membersFromIds, MIN_COUNCIL_MEMBERS } from "./members.ts";

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
    const discovery = buildDiscovery("nanogpt", parseCatalogBody(nanoCatalog), [], ["missing/vanished"]);
    const row = discovery.models.find((item) => item.id === "missing/vanished");
    assert.equal(row?.access, "UNAVAILABLE");
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
