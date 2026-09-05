import {
  extractErrorMessage,
  keyFingerprint,
  keyRejectedMessage,
  redact,
  sanitizeApiKey,
} from "./api-key.ts";
import { catalogFromIds, type CatalogCheckResult } from "./catalog.ts";
import {
  buildDiscovery,
  parseCatalogBody,
  pickProbeTargets,
  type CatalogEntry,
  type DiscoverySnapshot,
  type ModelProbe,
} from "./discover.ts";
import { coerceMembers } from "./members.ts";
import { providerName } from "./providers.ts";
import { ROLE_LABEL } from "./roles.ts";
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

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
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

export async function listCatalogWith(
  transport: ProviderTransport,
  apiKey: string,
): Promise<{ ok: true; entries: CatalogEntry[] } | { ok: false; error: string; code: "KEY_REJECTED" | "PROVIDER_UNREACHABLE" }> {
  const key = sanitizeApiKey(apiKey, transport.provider);
  if (!key) {
    return {
      ok: false,
      code: "KEY_REJECTED",
      error: `${transport.label} is not connected. Connect your API key before running the Council.`,
    };
  }
  const probe = await transport.listModels(key);
  if (probe.error || probe.status < 200 || probe.status >= 300) {
    const parsed = parseBody(probe.body);
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
    };
  }
  return { ok: true, entries: parseCatalogBody(parseBody(probe.body)) };
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
  const fingerprint = keyFingerprint(key, transport.provider);
  const checks: Record<string, ConnectionCheck> = {
    [transport.provider]: { ok: false, label: transport.label, detail: "Not checked" },
  };
  const logBase = (ok: boolean, error?: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify(
      {
        title: "Conversation Bot · API test log",
        result: ok ? "PASS" : "FAIL",
        time: new Date().toISOString(),
        probe: "server",
        provider: transport.provider,
        key: { chars: fingerprint.chars, prefix: fingerprint.prefix },
        error: error ?? null,
        checks: Object.fromEntries(
          Object.entries(checks).map(([id, row]) => [
            id,
            { label: row.label, result: row.ok ? "PASS" : "FAIL", detail: row.detail },
          ]),
        ),
        note: "The API secret is not included in this log.",
        ...extra,
      },
      null,
      2,
    );

  if (!key) {
    const error = `${transport.label} is not connected. Connect your API key before running the Council.`;
    checks[transport.provider] = { ok: false, label: transport.label, detail: error };
    return { ok: false, error, snapshot: null, checks, log: logBase(false, error) };
  }

  const catalog = await listCatalogWith(transport, key);
  if (!catalog.ok) {
    checks[transport.provider] = { ok: false, label: transport.label, detail: catalog.error };
    return { ok: false, error: catalog.error, snapshot: null, checks, log: logBase(false, catalog.error) };
  }

  const targets = pickProbeTargets(catalog.entries, selectedIds);
  const probes = await Promise.all(targets.map((id) => probeModelWith(transport, key, id)));
  const authFail = probes.find((row) => row.status === 401);
  if (authFail) {
    const error = keyRejectedMessage(
      authFail.status,
      extractErrorMessage(parseBody(authFail.body ?? ""), authFail.status),
      fingerprint,
      transport.provider,
    );
    checks[transport.provider] = { ok: false, label: transport.label, detail: error };
    return { ok: false, error, snapshot: null, checks, log: logBase(false, error) };
  }
  const creditFail = probes.find((row) => row.status === 402);
  if (creditFail && probes.every((row) => row.status === 402 || row.status === 0 || row.status >= 500)) {
    checks[transport.provider] = { ok: false, label: transport.label, detail: transport.creditMessage };
    return {
      ok: false,
      error: transport.creditMessage,
      snapshot: null,
      checks,
      log: logBase(false, transport.creditMessage),
    };
  }

  const snapshot = buildDiscovery(transport.provider, catalog.entries, probes, selectedIds);
  checks[transport.provider] = {
    ok: true,
    label: transport.label,
    detail: `Connected · ${catalog.entries.length} models · ${fingerprint.chars} characters`,
  };
  for (const id of selectedIds) {
    const row = snapshot.models.find((item) => item.id === id);
    const access = row?.access ?? "UNAVAILABLE";
    const role = row?.recommendedRole ? ROLE_LABEL[row.recommendedRole] : "Council";
    checks[id] = {
      ok: access === "AVAILABLE" || access === "UNKNOWN",
      label: row?.name ?? id,
      detail: `${access}${role ? ` · ${role}` : ""}`,
    };
  }
  const blockedSelected = selectedIds.filter((id) => {
    const row = snapshot.models.find((item) => item.id === id);
    return row?.access === "UNAVAILABLE" || row?.access === "NOT_INCLUDED";
  });
  const ok = blockedSelected.length === 0;
  const error = ok
    ? undefined
    : `MODEL_UNAVAILABLE: ${blockedSelected.join(", ")} is not accessible on ${providerName(transport.provider)}. Refresh models and pick a replacement.`;
  return {
    ok,
    error,
    snapshot,
    checks,
    log: logBase(ok, error, {
      catalog: { model_count: catalog.entries.length, probed: targets.length },
      recommended: snapshot.recommendedIds,
      selected: selectedIds,
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
): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string; snapshot?: DiscoverySnapshot }> {
  const unique = [...new Set(models.map((id) => id.trim()).filter(Boolean))];
  const discovered = await discoverAccountWith(transport, apiKey, unique);
  if (!discovered.snapshot) {
    return { ok: false, blocked: unique.map((id) => ({ id, access: "UNAVAILABLE" })), error: discovered.error };
  }
  const blocked = unique
    .map((id) => {
      const row = discovered.snapshot?.models.find((item) => item.id === id);
      return { id, access: row?.access ?? "UNAVAILABLE" };
    })
    .filter((row) => row.access === "UNAVAILABLE" || row.access === "NOT_INCLUDED");
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      snapshot: discovered.snapshot,
      error: `MODEL_UNAVAILABLE: ${blocked.map((row) => row.id).join(", ")} is not accessible on ${providerName(transport.provider)}. Refresh models and pick a replacement.`,
    };
  }
  return { ok: true, blocked: [], snapshot: discovered.snapshot };
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
  const models: Record<string, string> = Object.fromEntries(selectedIds.map((id, index) => [`m${index + 1}`, id]));
  return {
    ok: discovered.ok,
    error: discovered.error,
    checks: discovered.checks,
    models,
    log: discovered.log,
    catalog: discovered.snapshot ?? undefined,
  };
}
