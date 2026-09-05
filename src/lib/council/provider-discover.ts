import {
  extractErrorMessage,
  keyFingerprint,
  keyRejectedMessage,
  redact,
  sanitizeApiKey,
} from "./api-key.ts";
import { catalogFromIds, MODEL_UNAVAILABLE, type CatalogCheckResult } from "./catalog.ts";
import {
  accessCounts,
  availableModels,
  buildDiscovery,
  classifyVerified,
  isVerifiedAvailable,
  normalizeCatalogPayload,
  pickProbeTargets,
  pruneToAvailable,
  type CatalogEntry,
  type CatalogNormalizeResult,
  type CatalogShapeKind,
  type CatalogShapeMeta,
  type DiscoverySnapshot,
  type ModelProbe,
  type VerifiedAccess,
} from "./discover.ts";
import { coerceMembers } from "./members.ts";
import { providerName } from "./providers.ts";
import { emptyAccessCounts, formatTestLog, type CatalogParseLog } from "./test-log.ts";
import type { ConnectionCheck, PreflightClientReport, ProviderId } from "./types.ts";
import type { CouncilMember } from "./members.ts";

export type TransportProbe = {
  status: number;
  body: string;
  error?: string;
  latencyMs?: number;
};

export type ProviderTransport = {
  provider: ProviderId;
  label: string;
  listModels: (apiKey: string) => Promise<TransportProbe>;
  pingModel: (apiKey: string, modelId: string) => Promise<TransportProbe>;
  creditMessage: string;
};

function jsonPayload(body: string): unknown {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseLogFromNormalize(norm: CatalogNormalizeResult): CatalogParseLog {
  return {
    ok: norm.ok,
    code: norm.code,
    error: norm.error,
    meta: norm.meta,
  };
}

export type CatalogListOk = {
  ok: true;
  entries: CatalogEntry[];
  status: number;
  latencyMs: number;
  shape: CatalogShapeKind;
  meta: CatalogShapeMeta;
  parse: CatalogParseLog;
};

export type CatalogListFail = {
  ok: false;
  error: string;
  code: "KEY_REJECTED" | "PROVIDER_UNREACHABLE" | "CATALOG_PARSE_ERROR";
  status: number | "NETWORK_ERROR";
  latencyMs: number;
  shape: CatalogShapeKind | "none";
  meta?: CatalogShapeMeta;
  parse?: CatalogParseLog;
};

export async function listCatalogWith(
  transport: ProviderTransport,
  apiKey: string,
): Promise<CatalogListOk | CatalogListFail> {
  const key = sanitizeApiKey(apiKey, transport.provider);
  if (!key) {
    return {
      ok: false,
      code: "KEY_REJECTED",
      error: `${transport.label} is not connected. Connect your API key before running the Council.`,
      status: 0,
      latencyMs: 0,
      shape: "none",
    };
  }
  const probe = await transport.listModels(key);
  const latencyMs = probe.latencyMs ?? 0;
  const httpStatus = probe.status || "NETWORK_ERROR";
  if (probe.error || probe.status < 200 || probe.status >= 300) {
    const parsed = jsonPayload(probe.body);
    const error =
      probe.status === 401 || probe.status === 403
        ? keyRejectedMessage(
            probe.status,
            extractErrorMessage(parsed, probe.status),
            keyFingerprint(key, transport.provider),
            transport.provider,
          )
        : redact(probe.error || extractErrorMessage(parsed, probe.status), key);
    return {
      ok: false,
      code: probe.status === 401 || probe.status === 403 ? "KEY_REJECTED" : "PROVIDER_UNREACHABLE",
      error,
      status: httpStatus === "NETWORK_ERROR" ? "NETWORK_ERROR" : probe.status,
      latencyMs,
      shape: "none",
    };
  }
  const payload = jsonPayload(probe.body);
  const norm = normalizeCatalogPayload(payload);
  if (!norm.ok) {
    return {
      ok: false,
      code: "CATALOG_PARSE_ERROR",
      error: norm.error ?? "CATALOG_PARSE_ERROR: unsupported catalog shape.",
      status: probe.status,
      latencyMs,
      shape: norm.shape,
      meta: norm.meta,
      parse: parseLogFromNormalize(norm),
    };
  }
  return {
    ok: true,
    entries: norm.entries,
    status: probe.status,
    latencyMs,
    shape: norm.shape,
    meta: norm.meta,
    parse: parseLogFromNormalize(norm),
  };
}

export async function probeModelWith(
  transport: ProviderTransport,
  apiKey: string,
  modelId: string,
): Promise<ModelProbe> {
  const key = sanitizeApiKey(apiKey, transport.provider);
  const ping = await transport.pingModel(key, modelId);
  return {
    id: modelId,
    status: ping.status,
    error: ping.error,
    body: ping.body,
  };
}

export type DiscoverAccountResult = {
  ok: boolean;
  error?: string;
  snapshot: DiscoverySnapshot | null;
  checks: Record<string, ConnectionCheck>;
  log: string;
};

export async function discoverAccountWith(
  transport: ProviderTransport,
  apiKey: string,
  selectedIds: string[] = [],
): Promise<DiscoverAccountResult> {
  const key = sanitizeApiKey(apiKey, transport.provider);
  const checks: Record<string, ConnectionCheck> = {
    [transport.provider]: { ok: false, label: transport.label, detail: "Not checked" },
  };
  const makeLog = (opts: {
    ok: boolean;
    error?: string;
    catalogStatus: number | "NETWORK_ERROR";
    catalogCount: number;
    latencyMs?: number;
    probeIds?: string[];
    snapshot?: DiscoverySnapshot | null;
    selected?: string[];
    warnings?: string[];
    shape?: CatalogShapeKind | "none";
    parse?: CatalogParseLog;
    authenticated?: boolean;
  }) =>
    formatTestLog(
      {
        result: opts.ok ? "PASS" : "FAIL",
        provider: transport.provider,
        connection: {
          status: opts.ok ? "CONNECTED" : "FAILED",
          detail: opts.error ?? (opts.ok ? `${transport.label} connected` : "Connection failed"),
        },
        catalog: {
          http_status: opts.catalogStatus,
          model_count: opts.catalogCount,
          latency_ms: opts.latencyMs,
          response_shape: opts.shape ?? "none",
          parse: opts.parse,
        },
        probes: { performed: opts.probeIds?.length ?? 0, ids: opts.probeIds ?? [] },
        access: opts.snapshot ? accessCounts(opts.snapshot.models) : emptyAccessCounts(),
        recommended: opts.snapshot?.recommendedIds ?? [],
        selected: opts.selected ?? [],
        warnings: opts.warnings ?? [],
        error: opts.error ?? null,
        extra: { authenticated: opts.authenticated === true },
      },
      key,
    );

  if (!key) {
    const error = `${transport.label} is not connected. Connect your API key before running the Council.`;
    checks[transport.provider] = { ok: false, label: transport.label, detail: error };
    return {
      ok: false,
      error,
      snapshot: null,
      checks,
      log: makeLog({ ok: false, error, catalogStatus: 0, catalogCount: 0, authenticated: false }),
    };
  }

  const catalog = await listCatalogWith(transport, key);
  if (!catalog.ok) {
    checks[transport.provider] = { ok: false, label: transport.label, detail: catalog.error };
    return {
      ok: false,
      error: catalog.error,
      snapshot: null,
      checks,
      log: makeLog({
        ok: false,
        error: catalog.error,
        catalogStatus: catalog.status,
        catalogCount: 0,
        latencyMs: catalog.latencyMs,
        shape: catalog.shape,
        parse: catalog.parse,
        authenticated: false,
      }),
    };
  }

  const targets = pickProbeTargets(catalog.entries, selectedIds);
  const probes = await Promise.all(targets.map((id) => probeModelWith(transport, key, id)));
  const authFail = probes.find((row) => row.status === 401);
  if (authFail) {
    const error = keyRejectedMessage(
      authFail.status,
      extractErrorMessage(jsonPayload(authFail.body ?? ""), authFail.status),
      keyFingerprint(key, transport.provider),
      transport.provider,
    );
    checks[transport.provider] = { ok: false, label: transport.label, detail: error };
    return {
      ok: false,
      error,
      snapshot: null,
      checks,
      log: makeLog({
        ok: false,
        error,
        catalogStatus: catalog.status,
        catalogCount: catalog.entries.length,
        latencyMs: catalog.latencyMs,
        probeIds: targets,
        shape: catalog.shape,
        parse: catalog.parse,
        authenticated: false,
      }),
    };
  }
  const creditFail = probes.find((row) => row.status === 402);
  if (creditFail && probes.every((row) => row.status === 402 || row.status === 0 || row.status >= 500)) {
    checks[transport.provider] = { ok: false, label: transport.label, detail: transport.creditMessage };
    return {
      ok: false,
      error: transport.creditMessage,
      snapshot: null,
      checks,
      log: makeLog({
        ok: false,
        error: transport.creditMessage,
        catalogStatus: catalog.status,
        catalogCount: catalog.entries.length,
        latencyMs: catalog.latencyMs,
        probeIds: targets,
        shape: catalog.shape,
        parse: catalog.parse,
        authenticated: false,
      }),
    };
  }

  const snapshot = buildDiscovery(
    transport.provider,
    catalog.entries,
    probes,
    selectedIds,
    new Date().toISOString(),
    catalog.shape,
  );
  const usable = pruneToAvailable(selectedIds, snapshot.models);
  const warnings: string[] = [];
  for (const id of selectedIds) {
    if (id && !usable.includes(id)) warnings.push(`Dropped stale selection ${id} — not AVAILABLE on this scan.`);
  }
  const availableCount = availableModels(snapshot.models).length;
  checks[transport.provider] = {
    ok: true,
    label: transport.label,
    detail: `CONNECTED · ${catalog.entries.length} discovered · ${availableCount} available`,
  };
  return {
    ok: true,
    snapshot,
    checks,
    log: makeLog({
      ok: true,
      catalogStatus: catalog.status,
      catalogCount: catalog.entries.length,
      latencyMs: catalog.latencyMs,
      probeIds: targets,
      snapshot,
      selected: usable,
      warnings,
      shape: catalog.shape,
      parse: catalog.parse,
      authenticated: true,
    }),
  };
}

export async function catalogCheckWith(
  transport: ProviderTransport,
  apiKey: string,
  models: string[],
): Promise<CatalogCheckResult> {
  const catalog = await listCatalogWith(transport, apiKey);
  if (!catalog.ok) {
    return {
      ok: false,
      code: catalog.code,
      error: catalog.error,
      missing: models.filter(Boolean),
      available: [],
    };
  }
  const known = new Set(catalog.entries.map((row) => row.id));
  return catalogFromIds(transport.provider, models.map((id) => id.trim()).filter(Boolean), known);
}

export async function accessCheckWith(
  transport: ProviderTransport,
  apiKey: string,
  models: string[],
): Promise<{
  ok: boolean;
  blocked: Array<{ id: string; access: string }>;
  error?: string;
  snapshot?: DiscoverySnapshot;
  verified?: Array<{ id: string; access: VerifiedAccess; status: number }>;
}> {
  return verifySelectedWith(transport, apiKey, models);
}

export async function verifySelectedWith(
  transport: ProviderTransport,
  apiKey: string,
  models: string[],
): Promise<{
  ok: boolean;
  blocked: Array<{ id: string; access: string }>;
  error?: string;
  snapshot?: DiscoverySnapshot;
  verified?: Array<{ id: string; access: VerifiedAccess; status: number }>;
}> {
  const unique = [...new Set(models.map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) {
    return {
      ok: false,
      blocked: [],
      error: `${MODEL_UNAVAILABLE}: no selected models to verify on ${providerName(transport.provider)}.`,
    };
  }
  const key = sanitizeApiKey(apiKey, transport.provider);
  if (!key) {
    return {
      ok: false,
      blocked: unique.map((id) => ({ id, access: "UNAVAILABLE" })),
      error: `${transport.label} is not connected. Connect your API key before running the Council.`,
    };
  }
  const probes = await Promise.all(unique.map((id) => probeModelWith(transport, key, id)));
  const authFail = probes.find((row) => row.status === 401);
  if (authFail) {
    const error = keyRejectedMessage(
      authFail.status,
      extractErrorMessage(jsonPayload(authFail.body ?? ""), authFail.status),
      keyFingerprint(key, transport.provider),
      transport.provider,
    );
    return {
      ok: false,
      blocked: unique.map((id) => ({ id, access: "UNAVAILABLE" })),
      error,
    };
  }
  const verified = probes.map((probe) => ({
    id: probe.id,
    access: classifyVerified(probe),
    status: probe.status,
  }));
  const blocked = verified
    .filter((row) => !isVerifiedAvailable(row.access))
    .map((row) => ({ id: row.id, access: row.access }));
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      verified,
      error: `${MODEL_UNAVAILABLE}: ${blocked
        .map((row) => `${row.id} (${row.access})`)
        .join(", ")} is not VERIFIED_AVAILABLE on ${providerName(transport.provider)}. Refresh models and pick a replacement.`,
    };
  }
  return { ok: true, blocked: [], verified };
}

export async function preflightWith(
  transport: ProviderTransport,
  opts: {
    apiKey: string;
    members?: CouncilMember[];
    selectedIds?: string[];
    gptModel?: string;
    grokModel?: string;
    claudeModel?: string;
    synthesizerModel?: string;
  },
): Promise<PreflightClientReport & { catalog?: DiscoverySnapshot }> {
  const selectedIds = selectedIdsFromPreflight(opts);
  const discovered = await discoverAccountWith(transport, opts.apiKey, selectedIds);
  if (!discovered.snapshot) {
    return {
      ok: false,
      error: discovered.error,
      checks: discovered.checks,
      models: {},
      log: discovered.log,
    };
  }
  const usable = pruneToAvailable(selectedIds, discovered.snapshot.models);
  const missing = selectedIds.filter((id) => id && !usable.includes(id));
  const models: Record<string, string> = Object.fromEntries(usable.map((id, index) => [`m${index + 1}`, id]));
  if (missing.length) {
    const error = `${MODEL_UNAVAILABLE}: ${missing.join(", ")} is not accessible on ${providerName(transport.provider)}. Refresh models and pick a replacement.`;
    return {
      ok: false,
      error,
      checks: discovered.checks,
      models,
      log: discovered.log,
      catalog: discovered.snapshot,
    };
  }
  return {
    ok: discovered.ok,
    error: discovered.error,
    checks: discovered.checks,
    models,
    log: discovered.log,
    catalog: discovered.snapshot,
  };
}

export function selectedIdsFromPreflight(opts: {
  members?: CouncilMember[];
  selectedIds?: string[];
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
}): string[] {
  const members = coerceMembers(opts);
  if (members.length) return members.map((row) => row.modelId);
  return (opts.selectedIds ?? []).map((id) => id.trim()).filter(Boolean);
}
