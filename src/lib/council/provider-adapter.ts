/** Canonical provider adapter. Provider-specific HTTP and billing stay behind this contract. */

import {
  capabilitiesOf,
  classifyProbe,
  classifyVerified,
  discoveryFingerprint,
  normalizeCatalogPayload,
  providerModeOf,
  type CatalogEntry,
  type CatalogNormalizeResult,
  type ModelAccess,
  type ModelCapabilities,
  type ModelProbe,
  type VerifiedAccess,
} from "./discover.ts";
import { normalizeNanoGptBilling, type NanoGptBillingMode } from "./nano-billing.ts";
import { providerName } from "./providers.ts";
import type { ProviderId } from "./types.ts";

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
  billingMode?: NanoGptBillingMode;
  catalogUrl?: string;
  completeUrl?: string;
};

export type ProviderAdapter = {
  id: ProviderId;
  label: string;
  mode: string;
  fingerprint: string;
  catalogUrl?: string;
  completeUrl?: string;
  creditMessage: string;
  testConnection: (apiKey: string) => Promise<{ ok: boolean; status: number; error?: string; latencyMs: number }>;
  listModels: (apiKey: string) => Promise<TransportProbe>;
  normalizeCatalog: (payload: unknown) => CatalogNormalizeResult;
  probeModel: (apiKey: string, modelId: string) => Promise<TransportProbe>;
  classifyAccess: (probe: ModelProbe, catalogHas: boolean) => ModelAccess;
  classifyVerified: (probe: ModelProbe) => VerifiedAccess;
  getCapabilities: (entry: CatalogEntry) => ModelCapabilities;
  transport: () => ProviderTransport;
};

export function adapterFromTransport(transport: ProviderTransport): ProviderAdapter {
  const mode = providerModeOf(transport.provider, transport.billingMode);
  return {
    id: transport.provider,
    label: transport.label,
    mode,
    fingerprint: discoveryFingerprint(transport.provider, mode),
    catalogUrl: transport.catalogUrl,
    completeUrl: transport.completeUrl,
    creditMessage: transport.creditMessage,
    async testConnection(apiKey: string) {
      const listed = await transport.listModels(apiKey);
      if (listed.error || listed.status < 200 || listed.status >= 300) {
        return {
          ok: false,
          status: listed.status,
          error: listed.error || `${transport.label} catalog request failed.`,
          latencyMs: listed.latencyMs ?? 0,
        };
      }
      return { ok: true, status: listed.status, latencyMs: listed.latencyMs ?? 0 };
    },
    listModels: (apiKey) => transport.listModels(apiKey),
    normalizeCatalog: (payload) => normalizeCatalogPayload(payload),
    probeModel: (apiKey, modelId) => transport.pingModel(apiKey, modelId),
    classifyAccess: (probe, catalogHas) => classifyProbe(probe, catalogHas),
    classifyVerified: (probe) => classifyVerified(probe),
    getCapabilities: (entry) => capabilitiesOf(entry),
    transport: () => transport,
  };
}

export function adapterMode(provider: ProviderId, billing?: NanoGptBillingMode | string | null): string {
  return providerModeOf(provider, provider === "nanogpt" ? normalizeNanoGptBilling(billing) : undefined);
}

export type ScanIdentity = {
  provider?: string;
  billingMode?: string;
  mode?: string;
  fingerprint?: string;
};

export function scanFingerprintOf(
  catalog: ScanIdentity | null | undefined,
  fallbackProvider: ProviderId,
): string | null {
  if (!catalog) return null;
  if (catalog.fingerprint) return catalog.fingerprint;
  if (catalog.mode) return discoveryFingerprint(catalog.provider || fallbackProvider, catalog.mode);
  if (catalog.billingMode) return discoveryFingerprint(catalog.provider || fallbackProvider, catalog.billingMode);
  return null;
}

export function sameProviderScan(
  catalog: ScanIdentity | null | undefined,
  provider: ProviderId,
  billing?: NanoGptBillingMode | string | null,
): string | null {
  if (!catalog) return null;
  if (catalog.provider && catalog.provider !== provider) {
    return `Scan belongs to ${providerName(catalog.provider)}, not ${providerName(provider)}. Refresh models.`;
  }
  const want = discoveryFingerprint(provider, adapterMode(provider, billing));
  const have = scanFingerprintOf(catalog, provider);
  if (have && have !== want) {
    return `Scan belongs to ${have}, not ${want}. Refresh models.`;
  }
  return null;
}
