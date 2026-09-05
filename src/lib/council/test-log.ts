import type { DiscoveredModel, ModelAccess } from "./discover.ts";
import { accessCounts } from "./discover.ts";
import { containsSecret } from "./provider-error.ts";
import { redact } from "./api-key.ts";

export type ConnectionStatus = "CONNECTED" | "FAILED";

export type TestLogPayload = {
  result: "PASS" | "FAIL";
  time?: string;
  provider: string;
  connection: { status: ConnectionStatus; detail: string };
  catalog: {
    http_status: number | "NETWORK_ERROR";
    model_count: number;
    latency_ms?: number;
  };
  probes: { performed: number; ids: string[] };
  access: Record<ModelAccess, number>;
  recommended: string[];
  selected: string[];
  warnings: string[];
  error?: string | null;
  extra?: Record<string, unknown>;
};

export function emptyAccessCounts(): Record<ModelAccess, number> {
  return { AVAILABLE: 0, NOT_INCLUDED: 0, UNAVAILABLE: 0, UNKNOWN: 0 };
}

export function countsFromModels(models: DiscoveredModel[]): Record<ModelAccess, number> {
  return accessCounts(models);
}

export function formatTestLog(payload: TestLogPayload, apiKey = ""): string {
  const body: Record<string, unknown> = {
    title: "Conversation Bot · API test log",
    result: payload.result,
    time: payload.time ?? new Date().toISOString(),
    provider: payload.provider,
    connection: payload.connection,
    catalog: payload.catalog,
    probes: {
      performed: payload.probes.performed,
      ids: payload.probes.ids,
    },
    access: payload.access,
    recommended: payload.recommended,
    selected: payload.selected,
    warnings: payload.warnings,
    error: payload.error ?? null,
    note: "The API secret is not included in this log.",
  };
  if (payload.extra) {
    for (const [key, value] of Object.entries(payload.extra)) {
      if (key === "apiKey" || key === "Authorization" || key === "key") continue;
      body[key] = value;
    }
  }
  const text = JSON.stringify(body, null, 2);
  const redacted = apiKey ? redact(text, apiKey) : text;
  if (containsSecret(redacted)) {
    return redact(redacted.replace(/sk-(?:or|nano)-[A-Za-z0-9_-]+/gi, "[redacted]").replace(/orr_(?:live|test)_[A-Za-z0-9_-]+/gi, "[redacted]"), apiKey);
  }
  return redacted;
}
