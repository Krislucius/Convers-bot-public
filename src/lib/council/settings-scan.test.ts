import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDiscovery, currentConnectionView, parseCatalogBody } from "./discover.ts";
import {
  applyDiscovery,
  attemptIdFromLog,
  invalidateScan,
  persistScanFields,
  runCanonicalScan,
  scanView,
  selectionAfterScan,
  shouldApplyAttempt,
  stampAttemptLog,
  type ScanAttempt,
} from "./settings-scan.ts";
import { formatTestLog } from "./test-log.ts";

const subEntries = parseCatalogBody({
  data: [
    { id: "openai/gpt-5", name: "GPT-5", context_length: 200000 },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", context_length: 200000 },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1", context_length: 64000 },
    { id: "perplexity/sonar-pro", name: "Sonar Pro", context_length: 127000 },
    { id: "moonshotai/kimi-k2", name: "Kimi K2", context_length: 128000 },
    { id: "openai/gpt-5-pro-payg", name: "GPT-5 Pro PAYG", context_length: 200000 },
  ],
});

const connectedCatalog = buildDiscovery("nanogpt", subEntries, [
  { id: "openai/gpt-5", status: 200, body: "{}" },
  { id: "anthropic/claude-sonnet-4", status: 200, body: "{}" },
  { id: "deepseek/deepseek-r1", status: 200, body: "{}" },
  { id: "perplexity/sonar-pro", status: 200, body: "{}" },
  { id: "moonshotai/kimi-k2", status: 200, body: "{}" },
  { id: "openai/gpt-5-pro-payg", status: 403, body: "model not included in your subscription" },
]);

function passLog(attemptId: string, selected: string[]) {
  return stampAttemptLog(
    formatTestLog({
      result: "PASS",
      provider: "nanogpt",
      connection: { status: "CONNECTED", detail: "NanoGPT connected" },
      catalog: { http_status: 200, model_count: connectedCatalog.models.length, response_shape: "openai_data_array" },
      probes: { performed: 5, ids: selected },
      access: { AVAILABLE: 5, NOT_INCLUDED: 1, UNAVAILABLE: 0, UNKNOWN: 0 },
      recommended: connectedCatalog.recommendedIds,
      selected,
      warnings: [],
      extra: { billing: "subscription" },
    }),
    attemptId,
  );
}

function failLog(attemptId: string, error: string) {
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
    }),
    attemptId,
  );
}

const failed: ScanAttempt = {
  attemptId: "fail-1",
  status: "FAILED",
  catalog: connectedCatalog,
  selectedIds: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
  synthesizerModel: "",
  log: failLog("fail-1", "previous key rejected"),
  error: "previous key rejected",
  lastTestOk: false,
  lastTestAt: "2026-09-01T00:00:00.000Z",
};

describe("canonical Save/Refresh discovery", () => {
  it("Save and Refresh apply the same PASS report to the same attempt", () => {
    const selected = ["openai/gpt-5", "anthropic/claude-sonnet-4", "deepseek/deepseek-r1", "perplexity/sonar-pro", "moonshotai/kimi-k2"];
    const report = {
      ok: true,
      catalog: connectedCatalog,
      log: passLog("shared", selected),
    };
    const fromRefresh = applyDiscovery({
      attemptId: "shared",
      report,
      previousIds: selected,
      previousSynth: "",
      previousCatalog: failed.catalog,
      now: "2026-09-06T21:00:00.000Z",
    });
    const fromSave = applyDiscovery({
      attemptId: "shared",
      report,
      previousIds: selected,
      previousSynth: "",
      previousCatalog: failed.catalog,
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.deepEqual(fromSave, fromRefresh);
    assert.equal(fromSave.status, "CONNECTED");
    assert.equal(fromSave.lastTestOk, true);
    const view = currentConnectionView(fromSave.lastTestOk, fromSave.catalog);
    assert.equal(view.status, "CONNECTED");
    assert.equal(view.discovered, connectedCatalog.models.length);
    assert.equal(view.available, 5);
    assert.equal(fromSave.selectedIds.length, 5);
    assert.equal(attemptIdFromLog(fromSave.log), "shared");
    assert.equal(scanView(fromSave).logAttemptId, "shared");
    assert.equal(scanView(fromSave).attemptId, "shared");
  });

  it("Save after a FAILED state invalidates then CONNECTS without resurrecting FAIL", async () => {
    const order: string[] = [];
    const out = await runCanonicalScan({
      mode: "save",
      previous: failed,
      persistConfig: async () => {
        order.push("persistConfig");
      },
      discover: async () => {
        order.push("discover");
        return { ok: true, catalog: connectedCatalog, log: passLog("save-after-fail", failed.selectedIds) };
      },
      newId: () => "save-after-fail",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.deepEqual(out.order, ["persistConfig", "invalidate", "discover", "apply"]);
    assert.deepEqual(order, ["persistConfig", "discover"]);
    assert.equal(out.testing.status, "TESTING");
    assert.equal(out.testing.lastTestOk, null);
    assert.equal(out.testing.log, "");
    assert.equal(out.testing.error, null);
    assert.equal(scanView(out.testing).status, "TESTING");
    assert.equal(scanView(out.testing).discovered, 0);
    assert.equal(out.result.status, "CONNECTED");
    assert.equal(out.result.lastTestOk, true);
    assert.equal(out.result.error, null);
    assert.match(out.result.log, /"result": "PASS"/);
    assert.equal(out.result.log.includes("previous key rejected"), false);
    assert.equal(attemptIdFromLog(out.result.log), "save-after-fail");
    assert.equal(currentConnectionView(out.result.lastTestOk, out.result.catalog).status, "CONNECTED");
  });

  it("Save after a successful Refresh stays CONNECTED and keeps AVAILABLE selection", async () => {
    const selected = ["openai/gpt-5", "anthropic/claude-sonnet-4", "deepseek/deepseek-r1"];
    const afterRefresh = applyDiscovery({
      attemptId: "refresh-1",
      report: { ok: true, catalog: connectedCatalog, log: passLog("refresh-1", selected) },
      previousIds: selected,
      previousSynth: "openai/gpt-5",
      previousCatalog: null,
      now: "2026-09-06T21:00:00.000Z",
    });
    const saved = await runCanonicalScan({
      mode: "save",
      previous: afterRefresh,
      persistConfig: async () => undefined,
      discover: async () => ({ ok: true, catalog: connectedCatalog, log: passLog("save-after-refresh", selected) }),
      newId: () => "save-after-refresh",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.equal(saved.result.status, "CONNECTED");
    assert.deepEqual(saved.result.selectedIds, selected);
    assert.equal(saved.result.synthesizerModel, "openai/gpt-5");
    assert.equal(attemptIdFromLog(saved.result.log), "save-after-refresh");
    assert.equal(saved.result.log.includes("FAIL"), false);
  });

  it("Save twice does not resurrect the first FAIL", async () => {
    let n = 0;
    const first = await runCanonicalScan({
      mode: "save",
      previous: failed,
      persistConfig: async () => undefined,
      discover: async () => ({ ok: false, error: "temporary", log: failLog("s1", "temporary") }),
      newId: () => "s1",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.equal(first.result.status, "FAILED");
    const second = await runCanonicalScan({
      mode: "save",
      previous: first.result,
      persistConfig: async () => {
        n += 1;
      },
      discover: async () => ({
        ok: true,
        catalog: connectedCatalog,
        log: passLog("s2", first.result.selectedIds),
      }),
      newId: () => "s2",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.equal(n, 1);
    assert.equal(second.result.status, "CONNECTED");
    assert.equal(attemptIdFromLog(second.result.log), "s2");
    assert.equal(shouldApplyAttempt(second.result.attemptId, first.result.attemptId), false);
    assert.equal(shouldApplyAttempt(second.result.attemptId, "s2"), true);
    const persisted = persistScanFields(second.result);
    assert.equal(persisted.lastTestOk, true);
    assert.equal(persisted.lastTestLog.includes("temporary"), false);
  });

  it("drops PAYG-only / unavailable ids from a Subscription Council", () => {
    const kept = selectionAfterScan(
      ["openai/gpt-5", "openai/gpt-5-pro-payg", "anthropic/claude-sonnet-4"],
      connectedCatalog,
    );
    assert.deepEqual(kept, ["openai/gpt-5", "anthropic/claude-sonnet-4"]);
  });

  it("Refresh and Save share one pipeline: persist is Save-only, discover is shared", async () => {
    let persist = 0;
    let discover = 0;
    const discoverFn = async () => {
      discover += 1;
      return { ok: true, catalog: connectedCatalog, log: passLog("x", ["openai/gpt-5", "anthropic/claude-sonnet-4"]) };
    };
    const refreshed = await runCanonicalScan({
      mode: "refresh",
      previous: failed,
      persistConfig: async () => {
        persist += 1;
      },
      discover: discoverFn,
      newId: () => "refresh-shared",
      now: "2026-09-06T21:00:00.000Z",
    });
    const saved = await runCanonicalScan({
      mode: "save",
      previous: failed,
      persistConfig: async () => {
        persist += 1;
      },
      discover: discoverFn,
      newId: () => "save-shared",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.equal(persist, 1);
    assert.equal(discover, 2);
    assert.equal(refreshed.order.includes("persistConfig"), false);
    assert.deepEqual(saved.order, ["persistConfig", "invalidate", "discover", "apply"]);
    assert.equal(refreshed.result.status, saved.result.status);
    assert.deepEqual(refreshed.result.selectedIds, saved.result.selectedIds);
  });

  it("onInvalidate runs after persistConfig and before discover", async () => {
    const order: string[] = [];
    await runCanonicalScan({
      mode: "save",
      previous: failed,
      persistConfig: async () => {
        order.push("persistConfig");
      },
      discover: async () => {
        order.push("discover");
        return { ok: true, catalog: connectedCatalog, log: passLog("inv", failed.selectedIds) };
      },
      onInvalidate: () => {
        order.push("onInvalidate");
      },
      newId: () => "inv",
      now: "2026-09-06T21:00:00.000Z",
    });
    assert.deepEqual(order, ["persistConfig", "onInvalidate", "discover"]);
  });
});

describe("attempt isolation", () => {
  it("TESTING does not present previous FAILED counts or FAIL log as current", () => {
    const testing = invalidateScan(failed, "t1");
    const view = scanView(testing);
    assert.equal(view.status, "TESTING");
    assert.equal(view.discovered, 0);
    assert.equal(view.available, 0);
    assert.equal(view.error, null);
    assert.ok(view.stale);
    assert.equal(testing.log, "");
    assert.equal(testing.log.includes("FAIL"), false);
    assert.equal(view.logAttemptId, null);
    assert.equal(view.attemptId, "t1");
  });

  it("status, counts, selection, error, and log share attempt_id", () => {
    const attempt = applyDiscovery({
      attemptId: "atom-1",
      report: {
        ok: true,
        catalog: connectedCatalog,
        log: passLog("atom-1", ["openai/gpt-5", "anthropic/claude-sonnet-4"]),
      },
      previousIds: ["openai/gpt-5", "anthropic/claude-sonnet-4"],
      previousSynth: "",
      previousCatalog: failed.catalog,
      now: "2026-09-06T21:00:00.000Z",
    });
    const view = scanView(attempt);
    assert.equal(view.attemptId, "atom-1");
    assert.equal(view.logAttemptId, "atom-1");
    assert.equal(view.status, "CONNECTED");
    assert.equal(view.selected, 2);
    assert.equal(view.error, null);
    assert.equal(persistScanFields(attempt).lastTestOk, true);
  });
});
