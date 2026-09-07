import {
  extractErrorMessage,
  keyFingerprint,
  keyRejectedMessage,
  redact,
  sanitizeApiKey,
} from "./api-key.ts";
import type { ChatMessage, Completion, PreflightClientReport } from "./types.ts";
import { type CatalogCheckResult } from "./catalog.ts";
import {
  accessCheckWith,
  catalogCheckWith,
  discoverAccountWith,
  listCatalogWith,
  preflightWith,
  probeModelWith,
} from "./provider-discover.ts";
import { adapterFromTransport } from "./provider-adapter.ts";
import {
  COMPLETE_TIMEOUT_MS,
  ProviderError,
  formatProviderFailure,
  httpClassOfStatus,
  providerFailure,
  toProviderFailure,
} from "./provider-error.ts";

const BASE = "https://openrusrouter.ru/v1";
const PROVIDER = "openrusrouter" as const;
const API_LABEL = "OpenRusRouter";
const CREDIT_MESSAGE = "OpenRusRouter needs credits on this key. Add balance, then test again.";

export type ModelPricing = { prompt: number | null; completion: number | null };

type Probe = {
  path: string;
  status: number;
  latencyMs: number;
  body: string;
  headers: Record<string, string>;
  error?: string;
};

function headersFor(apiKey: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "X-Title": "Conversation Bot",
  };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function pickHeaders(res: Response): Record<string, string> {
  const names = ["content-type", "x-request-id", "cf-ray", "www-authenticate", "retry-after"];
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = res.headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

async function probeGet(path: string, apiKey: string, timeoutMs: number): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "GET",
      headers: headersFor(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      path,
      status: res.status,
      latencyMs: Date.now() - started,
      body: redact(await res.text(), apiKey),
      headers: pickHeaders(res),
    };
  } catch (err) {
    return {
      path,
      status: 0,
      latencyMs: Date.now() - started,
      body: "",
      headers: {},
      error: redact(err instanceof Error ? err.message : String(err), apiKey),
    };
  }
}

async function probePost(path: string, apiKey: string, payload: unknown, timeoutMs: number): Promise<Probe> {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: headersFor(apiKey, true),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      path,
      status: res.status,
      latencyMs: Date.now() - started,
      body: redact(await res.text(), apiKey),
      headers: pickHeaders(res),
    };
  } catch (err) {
    return {
      path,
      status: 0,
      latencyMs: Date.now() - started,
      body: "",
      headers: {},
      error: redact(err instanceof Error ? err.message : String(err), apiKey),
    };
  }
}

export function operatorError(err: unknown, apiKey = ""): string {
  if (err instanceof Error && /request limit was reached/i.test(err.message)) {
    return err.message;
  }
  if (err instanceof Error && /not connected|save an api key|ключ/i.test(err.message)) {
    return "OpenRusRouter is not connected. Connect your API key before running the Council.";
  }
  return formatProviderFailure(
    toProviderFailure(err, { provider: PROVIDER, model: "", stage: "request" }, apiKey),
  );
}

export function transport() {
  return {
    provider: PROVIDER,
    label: API_LABEL,
    creditMessage: CREDIT_MESSAGE,
    catalogUrl: `${BASE}/models`,
    completeUrl: `${BASE}/chat/completions`,
    listModels: (apiKey: string) => probeGet("/models", apiKey, 20000),
    pingModel: (apiKey: string, modelId: string) =>
      probePost(
        "/chat/completions",
        apiKey,
        {
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
        },
        15000,
      ),
  };
}

export function adapter() {
  return adapterFromTransport(transport());
}

export async function listCatalog(apiKey: string) {
  return listCatalogWith(adapter(), apiKey);
}

export async function probeModel(apiKey: string, modelId: string) {
  return probeModelWith(adapter(), apiKey, modelId);
}

export async function discoverAccount(apiKey: string, selectedIds: string[] = [], _billing?: string) {
  return discoverAccountWith(adapter(), apiKey, selectedIds);
}

export async function preflightWithKey(opts: {
  apiKey: string;
  members?: import("./members").CouncilMember[];
  selectedIds?: string[];
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  synthesizerModel?: string;
}): Promise<PreflightClientReport & { catalog?: import("./discover").DiscoverySnapshot }> {
  return preflightWith(adapter(), opts);
}

export async function catalogCheck(opts: {
  apiKey: string;
  models?: string[];
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  nanogptBilling?: string;
}): Promise<CatalogCheckResult> {
  const models =
    opts.models && opts.models.length
      ? opts.models
      : [opts.gptModel, opts.grokModel, opts.claudeModel].filter((id): id is string => Boolean(id));
  return catalogCheckWith(adapter(), opts.apiKey, models);
}

export async function accessCheck(opts: { apiKey: string; models: string[]; nanogptBilling?: string }) {
  return accessCheckWith(adapter(), opts.apiKey, opts.models);
}

export async function complete(opts: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
  nanogptBilling?: string;
}): Promise<Completion> {
  const key = sanitizeApiKey(opts.apiKey, PROVIDER);
  if (!key) throw new Error(`${API_LABEL} is not connected. Connect your API key before running the Council.`);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: headersFor(key, true),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError(toProviderFailure(err, { provider: PROVIDER, model: opts.model, stage: "complete" }, key));
  }
  const textBody = redact(await res.text(), key);
  let payload: unknown = null;
  try {
    payload = JSON.parse(textBody);
  } catch {
    payload = null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(keyRejectedMessage(res.status, extractErrorMessage(payload, res.status), keyFingerprint(key, PROVIDER), PROVIDER));
  }
  if (!res.ok) {
    throw new ProviderError(
      providerFailure({
        provider: PROVIDER,
        model: opts.model,
        stage: "complete",
        httpStatus: res.status,
        httpClass: httpClassOfStatus(res.status),
        raw: extractErrorMessage(payload, res.status),
      }),
    );
  }
  const data = (payload ?? {}) as {
    id?: string;
    model?: string;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    usage?: Record<string, unknown>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const text = Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : String(content);
  const usage = data.usage ?? {};
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const asInt = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const asFloat = (value: unknown): number | null => {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  return {
    text,
    model: String(data.model ?? opts.model),
    inputTokens: asInt(usage.prompt_tokens),
    cachedInputTokens: asInt(promptDetails.cached_tokens),
    outputTokens: asInt(usage.completion_tokens),
    reasoningTokens: asInt(completionDetails.reasoning_tokens),
    cost: asFloat(usage.cost),
    requestId: data.id ? String(data.id) : null,
    latencyMs: Date.now() - started,
  };
}
