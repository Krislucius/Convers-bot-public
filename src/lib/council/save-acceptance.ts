/** Save reports CONNECTED only after persist, catalog, auth probe, verify, completion, log, and reload. */

import { currentConnectionView } from "./discover.ts";
import { slotFor } from "./providers.ts";
import { applyDiscovery, attemptIdFromLog, stampAttemptLog, type DiscoveryReport, type ScanAttempt } from "./settings-scan.ts";
import type { AccountSettingsPublic, ProviderId } from "./types.ts";
import type { NanoGptBillingMode } from "./nano-billing.ts";

export const SAVE_STAGES = [
  "PERSIST_ROUND_TRIP",
  "CATALOG",
  "AUTH_PROBE",
  "VERIFY_SELECTED",
  "COMPLETION_PROBE",
  "ATTEMPT_LOG",
  "RELOAD",
] as const;

export type SaveStage = (typeof SAVE_STAGES)[number];

export type SaveStageResult = {
  stage: SaveStage;
  ok: boolean;
  error?: string;
};

export type VerifySelectedResult = {
  ok: boolean;
  blocked?: Array<{ id: string; access: string }>;
  error?: string;
};

export type CompletionProbeResult = {
  ok: boolean;
  error?: string;
  model?: string;
};

export function formatStageError(stage: SaveStage, error: string): string {
  const detail = error.trim() || "failed";
  return `${stage}: ${detail}`;
}

export function firstFailedStage(stages: SaveStageResult[]): SaveStageResult | null {
  return stages.find((row) => !row.ok) ?? null;
}

export function saveMayConnect(stages: SaveStageResult[]): boolean {
  const by = new Map(stages.map((row) => [row.stage, row]));
  return SAVE_STAGES.every((stage) => by.get(stage)?.ok === true);
}

function sameIdSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((id) => id.trim()).filter(Boolean));
  const right = new Set(b.map((id) => id.trim()).filter(Boolean));
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

type LogMeta = {
  result?: string;
  catalogStatus?: number | string;
  modelCount?: number;
  authenticated?: boolean | null;
  attemptId?: string | null;
};

export function logMeta(log: string): LogMeta {
  try {
    const data = JSON.parse(log) as {
      result?: unknown;
      catalog?: { http_status?: unknown; model_count?: unknown };
      extra?: { authenticated?: unknown };
      authenticated?: unknown;
      attempt_id?: unknown;
    };
    const extraAuth = data.extra && typeof data.extra === "object" ? data.extra.authenticated : undefined;
    const authenticated =
      extraAuth === true || data.authenticated === true
        ? true
        : extraAuth === false || data.authenticated === false
          ? false
          : null;
    return {
      result: typeof data.result === "string" ? data.result : undefined,
      catalogStatus: data.catalog?.http_status as number | string | undefined,
      modelCount: typeof data.catalog?.model_count === "number" ? data.catalog.model_count : undefined,
      authenticated,
      attemptId: typeof data.attempt_id === "string" ? data.attempt_id : null,
    };
  } catch {
    return { authenticated: null, attemptId: null };
  }
}

export function persistRoundTripStage(
  expected: { provider: ProviderId; nanogptBilling: NanoGptBillingMode },
  persisted: AccountSettingsPublic | null,
): SaveStageResult {
  if (!persisted) {
    return { stage: "PERSIST_ROUND_TRIP", ok: false, error: "Persist did not return account settings." };
  }
  if (persisted.provider !== expected.provider) {
    return {
      stage: "PERSIST_ROUND_TRIP",
      ok: false,
      error: `Provider round-trip was ${persisted.provider}, expected ${expected.provider}.`,
    };
  }
  if (expected.provider === "nanogpt" && persisted.nanogptBilling !== expected.nanogptBilling) {
    return {
      stage: "PERSIST_ROUND_TRIP",
      ok: false,
      error: `Billing round-trip was ${persisted.nanogptBilling}, expected ${expected.nanogptBilling}.`,
    };
  }
  if (!slotFor(persisted, expected.provider).saved) {
    return { stage: "PERSIST_ROUND_TRIP", ok: false, error: "API key was not persisted on this account." };
  }
  return { stage: "PERSIST_ROUND_TRIP", ok: true };
}

export function catalogStage(report: DiscoveryReport): SaveStageResult {
  const meta = logMeta(report.log);
  const count = report.catalog?.models.length ?? meta.modelCount ?? 0;
  const statusOk = meta.catalogStatus === 200 || meta.catalogStatus === "200";
  if ((report.catalog && count > 0) || (statusOk && count > 0)) {
    return { stage: "CATALOG", ok: true };
  }
  return { stage: "CATALOG", ok: false, error: report.error?.trim() || "Provider catalog request failed." };
}

export function authProbeStage(report: DiscoveryReport): SaveStageResult {
  const meta = logMeta(report.log);
  if (meta.authenticated === false) {
    return { stage: "AUTH_PROBE", ok: false, error: report.error?.trim() || "Authenticated provider probe failed." };
  }
  if (meta.authenticated === true || (report.ok && report.catalog)) {
    return { stage: "AUTH_PROBE", ok: true };
  }
  return { stage: "AUTH_PROBE", ok: false, error: report.error?.trim() || "Authenticated provider probe failed." };
}

export function verifySelectedStage(selectedIds: string[], verify: VerifySelectedResult): SaveStageResult {
  const ids = [...new Set(selectedIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) {
    return { stage: "VERIFY_SELECTED", ok: false, error: "No selected Council models to verify." };
  }
  const blocked = verify.blocked?.filter((row) => row.access !== "VERIFIED_AVAILABLE" && row.access !== "AVAILABLE") ?? [];
  if (!verify.ok || blocked.length) {
    return {
      stage: "VERIFY_SELECTED",
      ok: false,
      error:
        verify.error?.trim() ||
        `${blocked.map((row) => `${row.id} (${row.access})`).join(", ") || "selected model"} is not VERIFIED_AVAILABLE.`,
    };
  }
  return { stage: "VERIFY_SELECTED", ok: true };
}

export function completionProbeStage(probe: CompletionProbeResult): SaveStageResult {
  if (probe.ok) return { stage: "COMPLETION_PROBE", ok: true };
  return {
    stage: "COMPLETION_PROBE",
    ok: false,
    error: probe.error?.trim() || "Lightweight completion probe failed.",
  };
}

export function attemptLogStage(attemptId: string, log: string): SaveStageResult {
  const id = attemptIdFromLog(log);
  if (id === attemptId) return { stage: "ATTEMPT_LOG", ok: true };
  return {
    stage: "ATTEMPT_LOG",
    ok: false,
    error: `Test Log attempt_id was ${id || "(missing)"}, expected ${attemptId}.`,
  };
}

export function reloadStage(
  expected: {
    provider: ProviderId;
    nanogptBilling: NanoGptBillingMode;
    selectedIds: string[];
    attemptId: string;
  },
  loaded: AccountSettingsPublic | null,
): SaveStageResult {
  if (!loaded) {
    return { stage: "RELOAD", ok: false, error: "Reload did not return account settings." };
  }
  if (loaded.provider !== expected.provider) {
    return { stage: "RELOAD", ok: false, error: `Provider was not preserved (${loaded.provider}).` };
  }
  if (expected.provider === "nanogpt" && loaded.nanogptBilling !== expected.nanogptBilling) {
    return { stage: "RELOAD", ok: false, error: `Billing mode was not preserved (${loaded.nanogptBilling}).` };
  }
  if (!sameIdSet(loaded.selectedModelIds, expected.selectedIds)) {
    return { stage: "RELOAD", ok: false, error: "Selected models were not preserved." };
  }
  if (!slotFor(loaded, expected.provider).saved) {
    return { stage: "RELOAD", ok: false, error: "Reloaded account has no stored credential." };
  }
  if (loaded.credentialPresent === false) {
    return { stage: "RELOAD", ok: false, error: "Reloaded account has no stored credential." };
  }
  const view = currentConnectionView(loaded.lastTestOk, loaded.catalog, true);
  const meta = logMeta(loaded.lastTestLog);
  if (loaded.lastTestOk !== true || view.status !== "CONNECTED") {
    return { stage: "RELOAD", ok: false, error: "Connection status is not CONNECTED after reload." };
  }
  if (meta.result === "FAIL") {
    return { stage: "RELOAD", ok: false, error: "Stale FAILED state returned after reload." };
  }
  if (attemptIdFromLog(loaded.lastTestLog) !== expected.attemptId) {
    return { stage: "RELOAD", ok: false, error: "Reloaded Test Log does not belong to this save attempt." };
  }
  return { stage: "RELOAD", ok: true };
}

export function stampAcceptanceLog(log: string, attemptId: string, stages: SaveStageResult[]): string {
  const failed = firstFailedStage(stages);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(log || "{}") as Record<string, unknown>;
  } catch {
    data = { title: "Conversation Bot · API test log" };
  }
  data.attempt_id = attemptId;
  data.acceptance = {
    stages: Object.fromEntries(stages.map((row) => [row.stage, row.ok ? "PASS" : "FAIL"])),
    failed_stage: failed?.stage ?? null,
    error: failed ? formatStageError(failed.stage, failed.error || "failed") : null,
  };
  if (failed) {
    data.result = "FAIL";
    data.error = formatStageError(failed.stage, failed.error || "failed");
    data.connection = { status: "FAILED", detail: formatStageError(failed.stage, failed.error || "failed") };
  } else if (saveMayConnect(stages)) {
    data.result = "PASS";
    if (!data.connection) data.connection = { status: "CONNECTED", detail: "Save acceptance passed" };
  }
  return stampAttemptLog(JSON.stringify(data, null, 2), attemptId);
}

function failedAttempt(opts: {
  attemptId: string;
  previous: ScanAttempt;
  report: DiscoveryReport;
  stages: SaveStageResult[];
  selectedIds?: string[];
  now?: string;
}): ScanAttempt {
  const failed = firstFailedStage(opts.stages);
  const error = failed ? formatStageError(failed.stage, failed.error || "failed") : "Connection failed.";
  const base = applyDiscovery({
    attemptId: opts.attemptId,
    report: { ok: false, error, catalog: opts.report.catalog ?? null, log: opts.report.log },
    previousIds: opts.selectedIds ?? opts.previous.selectedIds,
    previousSynth: opts.previous.synthesizerModel,
    previousCatalog: opts.report.catalog ?? opts.previous.catalog,
    now: opts.now,
  });
  return {
    ...base,
    selectedIds: opts.selectedIds ?? base.selectedIds,
    status: "FAILED",
    lastTestOk: false,
    error,
    log: stampAcceptanceLog(opts.report.log || base.log, opts.attemptId, opts.stages),
  };
}

/**
 * Save CONNECTED only when every acceptance stage PASSes.
 * Refresh does not use this path.
 */
export async function runSaveAcceptance(opts: {
  attemptId: string;
  previous: ScanAttempt;
  persisted: AccountSettingsPublic | null;
  expected: { provider: ProviderId; nanogptBilling: NanoGptBillingMode };
  report: DiscoveryReport;
  verifySelected: (ids: string[]) => Promise<VerifySelectedResult>;
  completionProbe: (args: {
    model: string;
    provider: ProviderId;
    nanogptBilling: NanoGptBillingMode;
  }) => Promise<CompletionProbeResult>;
  persistResult: (attempt: ScanAttempt) => Promise<void>;
  reload: () => Promise<AccountSettingsPublic>;
  now?: string;
}): Promise<{ result: ScanAttempt; stages: SaveStageResult[]; reloaded: AccountSettingsPublic | null }> {
  const stages: SaveStageResult[] = [];
  const fail = async (selectedIds?: string[]) => {
    const result = failedAttempt({
      attemptId: opts.attemptId,
      previous: opts.previous,
      report: opts.report,
      stages,
      selectedIds,
      now: opts.now,
    });
    try {
      await opts.persistResult(result);
    } catch {
      /* on-screen FAILED is already the attempt */
    }
    return { result, stages, reloaded: null };
  };

  stages.push(persistRoundTripStage(opts.expected, opts.persisted));
  if (!stages[0].ok) return fail();

  stages.push(catalogStage(opts.report));
  if (!stages[1].ok) return fail();

  stages.push(authProbeStage(opts.report));
  if (!stages[2].ok) return fail();

  const candidate = applyDiscovery({
    attemptId: opts.attemptId,
    report: opts.report,
    previousIds: opts.previous.selectedIds,
    previousSynth: opts.previous.synthesizerModel,
    previousCatalog: opts.previous.catalog,
    now: opts.now,
  });
  const verify = await opts.verifySelected(candidate.selectedIds);
  stages.push(verifySelectedStage(candidate.selectedIds, verify));
  if (!stages[3].ok) return fail(candidate.selectedIds);

  const model = candidate.synthesizerModel || candidate.selectedIds[0] || "";
  const probe = await opts.completionProbe({
    model,
    provider: opts.expected.provider,
    nanogptBilling: opts.expected.nanogptBilling,
  });
  stages.push(completionProbeStage({ ...probe, model }));
  if (!stages[4].ok) return fail(candidate.selectedIds);

  const preReload = stampAcceptanceLog(candidate.log, opts.attemptId, stages);
  stages.push(attemptLogStage(opts.attemptId, preReload));
  if (!stages[5].ok) return fail(candidate.selectedIds);

  const connected: ScanAttempt = {
    ...candidate,
    status: "CONNECTED",
    lastTestOk: true,
    error: null,
    log: preReload,
  };
  await opts.persistResult(connected);
  let reloaded: AccountSettingsPublic | null = null;
  try {
    reloaded = await opts.reload();
  } catch (err) {
    stages.push({
      stage: "RELOAD",
      ok: false,
      error: err instanceof Error ? err.message : "Reload failed.",
    });
    return fail(candidate.selectedIds);
  }
  stages.push(
    reloadStage(
      {
        provider: opts.expected.provider,
        nanogptBilling: opts.expected.nanogptBilling,
        selectedIds: connected.selectedIds,
        attemptId: opts.attemptId,
      },
      reloaded,
    ),
  );
  if (!stages[6].ok) return fail(candidate.selectedIds);

  const log = stampAcceptanceLog(connected.log, opts.attemptId, stages);
  const result: ScanAttempt = { ...connected, log };
  try {
    await opts.persistResult(result);
  } catch {
    /* reload already proved CONNECTED */
  }
  return { result, stages, reloaded };
}
