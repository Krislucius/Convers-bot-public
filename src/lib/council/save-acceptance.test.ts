import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiscovery, parseCatalogBody } from "./discover.ts";
import {
  firstFailedStage,
  persistRoundTripStage,
  runSaveAcceptance,
  saveMayConnect,
  stampAcceptanceLog,
  type SaveStageResult,
} from "./save-acceptance.ts";
import { attemptIdFromLog, emptyScan, stampAttemptLog, type DiscoveryReport, type ScanAttempt } from "./settings-scan.ts";
import { formatTestLog } from "./test-log.ts";
import type { AccountSettingsPublic } from "./types.ts";

const subEntries = parseCatalogBody({
  data: [
    { id: "openai/gpt-5", name: "GPT-5", context_length: 200000 },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000 },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1", context_length: 64000 },
  ],
});

const connectedCatalog = buildDiscovery("nanogpt", subEntries, [
  { id: "openai/gpt-5", status: 200, body: "{}" },
  { id: "anthropic/claude-sonnet-4", status: 200, body: "{}" },
  { id: "deepseek/deepseek-r1", status: 200, body: "{}" },
]);

const selected = ["openai/gpt-5", "anthropic/claude-sonnet-4"];

function passLog(attemptId: string) {
  return stampAttemptLog(
    formatTestLog({
      result: "PASS",
      provider: "nanogpt",
      connection: { status: "CONNECTED", detail: "NanoGPT connected" },
      catalog: { http_status: 200, model_count: connectedCatalog.models.length, response_shape: "openai_data_array" },
      probes: { performed: 2, ids: selected },
      access: { AVAILABLE: 3, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
      recommended: connectedCatalog.recommendedIds,
      selected,
      warnings: [],
      extra: { authenticated: true, billing: "subscription" },
    }),
    attemptId,
  );
}

function failLog(attemptId: string, error: string, extra?: Record<string, unknown>) {
  return stampAttemptLog(
    formatTestLog({
      result: "FAIL",
      provider: "nanogpt",
      connection: { status: "FAILED", detail: error },
      catalog: { http_status: 401, model_count: 0, response_shape: "none" },
      probes: { performed: 0, ids: [] },
      access: { AVAILABLE: 0, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
      recommended: [],
      selected: [],
      warnings: [],
      error,
      extra: { authenticated: false, ...extra },
    }),
    attemptId,
  );
}

const previous: ScanAttempt = {
  ...emptyScan("prev"),
  selectedIds: selected,
};

function publicSettings(over: Partial<AccountSettingsPublic> = {}): AccountSettingsPublic {
  return {
    provider: "nanogpt",
    selectedModelIds: selected,
    synthesizerModel: "",
    catalog: connectedCatalog,
    gptModel: selected[0],
    grokModel: selected[1] ?? "",
    claudeModel: "",
    maxCostUsd: 1,
    lastTestLog: "",
    lastTestAt: null,
    lastTestOk: null,
    nanogptBilling: "subscription",
    nanogpt: { saved: true, masked: "sk-nano-••••" },
    openrouter: { saved: false, masked: "" },
    openrusrouter: { saved: false, masked: "" },
    ...over,
  };
}

const passReport: DiscoveryReport = {
  ok: true,
  catalog: connectedCatalog,
  log: passLog("save-1"),
};

function harness(over: {
  persisted?: AccountSettingsPublic | null;
  report?: DiscoveryReport;
  verify?: { ok: boolean; blocked?: Array<{ id: string; access: string }>; error?: string };
  probeOk?: boolean;
  probeError?: string;
  reload?: (stored: AccountSettingsPublic) => AccountSettingsPublic;
  attemptId?: string;
} = {}) {
  const attemptId = over.attemptId ?? "save-1";
  let stored: AccountSettingsPublic = publicSettings();
  const calls = { verify: 0, probe: 0, persist: 0, reload: 0, probeBilling: "" as string };
  return {
    calls,
    stored: () => stored,
    run: () =>
      runSaveAcceptance({
        attemptId,
        previous,
        persisted: over.persisted === undefined ? publicSettings() : over.persisted,
        expected: { provider: "nanogpt", nanogptBilling: "subscription" },
        report: over.report ?? { ...passReport, log: passLog(attemptId) },
        verifySelected: async () => {
          calls.verify += 1;
          return over.verify ?? { ok: true, blocked: [] };
        },
        completionProbe: async (args) => {
          calls.probe += 1;
          calls.probeBilling = args.nanogptBilling;
          return { ok: over.probeOk !== false, error: over.probeError, model: args.model };
        },
        persistResult: async (attempt) => {
          calls.persist += 1;
          stored = publicSettings({
            lastTestOk: attempt.lastTestOk,
            lastTestLog: attempt.log,
            lastTestAt: attempt.lastTestAt,
            selectedModelIds: attempt.selectedIds,
            catalog: attempt.catalog,
            provider: "nanogpt",
            nanogptBilling: "subscription",
          });
        },
        reload: async () => {
          calls.reload += 1;
          return over.reload ? over.reload(stored) : stored;
        },
        now: "2026-09-06T21:40:00.000Z",
      }),
  };
}

describe("Save connection acceptance", () => {
  it("reports CONNECTED only when persist, catalog, probe, verify, completion, log, and reload PASS", async () => {
    const h = harness();
    const out = await h.run();
    assert.equal(out.result.status, "CONNECTED");
    assert.equal(out.result.lastTestOk, true);
    assert.equal(out.result.error, null);
    assert.equal(saveMayConnect(out.stages), true);
    assert.equal(firstFailedStage(out.stages), null);
    assert.equal(attemptIdFromLog(out.result.log), "save-1");
    assert.equal(h.calls.verify, 1);
    assert.equal(h.calls.probe, 1);
    assert.equal(h.calls.probeBilling, "subscription");
    assert.equal(h.calls.reload, 1);
    assert.match(out.result.log, /"result": "PASS"/);
    const view = JSON.parse(out.result.log) as { acceptance: { failed_stage: null } };
    assert.equal(view.acceptance.failed_stage, null);
  });

  it("FAILED persist round-trip never reports CONNECTED", async () => {
    const h = harness({ persisted: publicSettings({ nanogpt: { saved: false, masked: "" } }) });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.equal(out.result.lastTestOk, false);
    assert.match(out.result.error ?? "", /^PERSIST_ROUND_TRIP:/);
    assert.equal(h.calls.verify, 0);
    assert.equal(h.calls.probe, 0);
    assert.equal(saveMayConnect(out.stages), false);
  });

  it("reload CONNECTED without a stored credential is FAILED", async () => {
    const h = harness({
      reload: () =>
        publicSettings({
          nanogpt: { saved: false, masked: "" },
          credentialPresent: false,
          lastTestOk: true,
          lastTestLog: passLog("save-1"),
        }),
    });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^RELOAD:/);
    assert.equal(saveMayConnect(out.stages), false);
  });

  it("FAILED catalog never reports CONNECTED", async () => {
    const h = harness({
      report: {
        ok: false,
        error: "CATALOG_PARSE_ERROR: unsupported catalog shape.",
        catalog: null,
        log: failLog("save-1", "CATALOG_PARSE_ERROR: unsupported catalog shape."),
      },
    });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^CATALOG:/);
    assert.equal(h.calls.verify, 0);
  });

  it("FAILED authenticated probe never reports CONNECTED", async () => {
    const catalogThenAuthFail = stampAttemptLog(
      formatTestLog({
        result: "FAIL",
        provider: "nanogpt",
        connection: { status: "FAILED", detail: "API key rejected." },
        catalog: { http_status: 200, model_count: 3, response_shape: "openai_data_array" },
        probes: { performed: 1, ids: ["openai/gpt-5"] },
        access: { AVAILABLE: 0, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 },
        recommended: [],
        selected: [],
        warnings: [],
        error: "API key rejected.",
        extra: { authenticated: false, billing: "subscription" },
      }),
      "save-1",
    );
    const h = harness({
      report: { ok: false, error: "API key rejected.", catalog: null, log: catalogThenAuthFail },
    });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^AUTH_PROBE:/);
    assert.equal(h.calls.verify, 0);
  });

  it("FAILED verify selected never reports CONNECTED and skips completion", async () => {
    const h = harness({
      verify: {
        ok: false,
        blocked: [{ id: "openai/gpt-5", access: "NOT_INCLUDED" }],
        error: "MODEL_UNAVAILABLE: openai/gpt-5 (NOT_INCLUDED) is not VERIFIED_AVAILABLE on NanoGPT.",
      },
    });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^VERIFY_SELECTED:/);
    assert.equal(h.calls.probe, 0);
    assert.equal(saveMayConnect(out.stages), false);
  });

  it("FAILED completion probe through the billing mode never reports CONNECTED", async () => {
    const h = harness({ probeOk: false, probeError: "SUBSCRIPTION_LIMIT_REACHED: HTTP 429" });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^COMPLETION_PROBE:/);
    assert.match(out.result.error ?? "", /SUBSCRIPTION_LIMIT_REACHED/);
    assert.equal(h.calls.probeBilling, "subscription");
  });

  it("reload must keep provider, billing, selection, CONNECTED, and the same attempt_id", async () => {
    const h = harness();
    const out = await h.run();
    assert.equal(out.reloaded?.provider, "nanogpt");
    assert.equal(out.reloaded?.nanogptBilling, "subscription");
    assert.deepEqual(out.reloaded?.selectedModelIds, selected);
    assert.equal(out.reloaded?.lastTestOk, true);
    assert.equal(attemptIdFromLog(out.reloaded?.lastTestLog ?? ""), "save-1");
  });

  it("stale FAILED after reload is RELOAD failure, not CONNECTED", async () => {
    const h = harness({
      reload: () =>
        publicSettings({
          lastTestOk: false,
          lastTestLog: failLog("old-fail", "previous key rejected"),
        }),
    });
    const out = await h.run();
    assert.equal(out.result.status, "FAILED");
    assert.match(out.result.error ?? "", /^RELOAD:/);
    assert.match(out.result.error ?? "", /FAILED|CONNECTED/i);
    assert.equal(out.result.log.includes("previous key rejected") || /RELOAD/.test(out.result.error ?? ""), true);
  });

  it("billing mismatch on persist round-trip fails before discovery work", () => {
    const stage = persistRoundTripStage(
      { provider: "nanogpt", nanogptBilling: "subscription" },
      publicSettings({ nanogptBilling: "payg" }),
    );
    assert.equal(stage.ok, false);
    assert.match(stage.error ?? "", /Billing round-trip/);
  });

  it("Test Log of a PASS shares the save attempt_id", () => {
    const stages: SaveStageResult[] = [
      { stage: "PERSIST_ROUND_TRIP", ok: true },
      { stage: "CATALOG", ok: true },
      { stage: "AUTH_PROBE", ok: true },
      { stage: "VERIFY_SELECTED", ok: true },
      { stage: "COMPLETION_PROBE", ok: true },
      { stage: "ATTEMPT_LOG", ok: true },
      { stage: "RELOAD", ok: true },
    ];
    const log = stampAcceptanceLog(passLog("atom"), "atom", stages);
    assert.equal(attemptIdFromLog(log), "atom");
    assert.equal(saveMayConnect(stages), true);
  });
});
