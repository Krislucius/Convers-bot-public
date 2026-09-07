/** Save and Refresh share one discovery apply. Save never keeps a parallel scan. */

import { currentConnectionView, pruneToAvailable, type DiscoverySnapshot } from "./discover.ts";
import { MAX_COUNCIL_MEMBERS } from "./members.ts";

export type ScanStatus = "IDLE" | "TESTING" | "CONNECTED" | "FAILED";

export type DiscoveryReport = {
  ok: boolean;
  error?: string;
  catalog?: DiscoverySnapshot | null;
  log: string;
};

export type ScanAttempt = {
  attemptId: string;
  status: ScanStatus;
  catalog: DiscoverySnapshot | null;
  selectedIds: string[];
  synthesizerModel: string;
  log: string;
  error: string | null;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
};

export function newAttemptId(): string {
  return crypto.randomUUID();
}

export function emptyScan(attemptId = "idle"): ScanAttempt {
  return {
    attemptId,
    status: "IDLE",
    catalog: null,
    selectedIds: [],
    synthesizerModel: "",
    log: "",
    error: null,
    lastTestOk: null,
    lastTestAt: null,
  };
}

/** Drop the current attempt so Status/counts/log cannot keep a previous FAIL or PASS. */
export function invalidateScan(previous: ScanAttempt, attemptId: string): ScanAttempt {
  return {
    attemptId,
    status: "TESTING",
    catalog: previous.catalog,
    selectedIds: previous.selectedIds,
    synthesizerModel: previous.synthesizerModel,
    log: "",
    error: null,
    lastTestOk: null,
    lastTestAt: previous.lastTestAt,
  };
}

export function shouldApplyAttempt(currentAttemptId: string, incomingAttemptId: string): boolean {
  return Boolean(currentAttemptId) && currentAttemptId === incomingAttemptId;
}

/**
 * Keep the current Council only when every selected id is still VERIFIED_AVAILABLE.
 * Otherwise drop the invalid ids. An empty previous selection takes the recommendation.
 */
export function selectionAfterScan(previousIds: string[], catalog: DiscoverySnapshot): string[] {
  const previous = [...new Set(previousIds.map((id) => id.trim()).filter(Boolean))];
  if (!previous.length) return catalog.recommendedIds.slice(0, MAX_COUNCIL_MEMBERS);
  return pruneToAvailable(previous, catalog.models);
}

export function stampAttemptLog(log: string, attemptId: string): string {
  try {
    const data = JSON.parse(log) as Record<string, unknown>;
    data.attempt_id = attemptId;
    return JSON.stringify(data, null, 2);
  } catch {
    return log;
  }
}

export function attemptIdFromLog(log: string): string | null {
  try {
    const data = JSON.parse(log) as { attempt_id?: unknown };
    return typeof data.attempt_id === "string" && data.attempt_id ? data.attempt_id : null;
  } catch {
    return null;
  }
}

export function applyDiscovery(opts: {
  attemptId: string;
  report: DiscoveryReport;
  previousIds: string[];
  previousSynth: string;
  previousCatalog: DiscoverySnapshot | null;
  now?: string;
}): ScanAttempt {
  const lastTestAt = opts.now ?? new Date().toISOString();
  const log = stampAttemptLog(opts.report.log || "", opts.attemptId);
  if (opts.report.ok && opts.report.catalog) {
    const selectedIds = selectionAfterScan(opts.previousIds, opts.report.catalog);
    return {
      attemptId: opts.attemptId,
      status: "CONNECTED",
      catalog: opts.report.catalog,
      selectedIds,
      synthesizerModel: selectedIds.includes(opts.previousSynth) ? opts.previousSynth : "",
      log,
      error: null,
      lastTestOk: true,
      lastTestAt,
    };
  }
  return {
    attemptId: opts.attemptId,
    status: "FAILED",
    catalog: opts.previousCatalog,
    selectedIds: opts.previousIds,
    synthesizerModel: opts.previousSynth,
    log,
    error: opts.report.error?.trim() || "Connection failed.",
    lastTestOk: false,
    lastTestAt,
  };
}

export function scanView(attempt: ScanAttempt) {
  const view = currentConnectionView(attempt.lastTestOk, attempt.catalog);
  return {
    ...view,
    status: attempt.status === "TESTING" ? "TESTING" : view.status,
    attemptId: attempt.attemptId,
    selected: attempt.selectedIds.length,
    error: attempt.error,
    logAttemptId: attemptIdFromLog(attempt.log),
  };
}

export function persistScanFields(attempt: ScanAttempt): {
  selectedModelIds: string[];
  synthesizerModel: string;
  catalog: DiscoverySnapshot | null;
  lastTestLog: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
} {
  return {
    selectedModelIds: attempt.selectedIds,
    synthesizerModel: attempt.synthesizerModel,
    catalog: attempt.catalog,
    lastTestLog: attempt.log,
    lastTestAt: attempt.lastTestAt,
    lastTestOk: attempt.lastTestOk,
  };
}

/**
 * Save: persist provider/billing/key, invalidate, discover, apply.
 * Refresh: same discover + apply, no separate logic.
 */
export async function runCanonicalScan(opts: {
  mode: "save" | "refresh";
  previous: ScanAttempt;
  persistConfig?: () => Promise<void>;
  discover: () => Promise<DiscoveryReport>;
  onInvalidate?: (testing: ScanAttempt) => void;
  now?: string;
  newId?: () => string;
}): Promise<{ attemptId: string; testing: ScanAttempt; result: ScanAttempt; order: string[] }> {
  const order: string[] = [];
  const attemptId = opts.newId?.() ?? newAttemptId();
  if (opts.mode === "save") {
    if (!opts.persistConfig) throw new Error("Save requires persistConfig before discovery.");
    order.push("persistConfig");
    await opts.persistConfig();
  }
  const testing = invalidateScan(opts.previous, attemptId);
  order.push("invalidate");
  opts.onInvalidate?.(testing);
  order.push("discover");
  const report = await opts.discover();
  const result = applyDiscovery({
    attemptId,
    report,
    previousIds: opts.previous.selectedIds,
    previousSynth: opts.previous.synthesizerModel,
    previousCatalog: opts.previous.catalog,
    now: opts.now,
  });
  order.push("apply");
  return { attemptId, testing, result, order };
}
