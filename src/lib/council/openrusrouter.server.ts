import {
  extractErrorMessage,
  keyFingerprint,
  keyRejectedMessage,
  redact,
  sanitizeApiKey,
} from "./api-key";
import type { ChatMessage, Completion, ConnectionCheck, PreflightClientReport } from "./types";

const BASE = "https://openrusrouter.ru/v1";
const PROVIDER = "openrusrouter" as const;

export type ModelPricing = { prompt: number | null; completion: number | null };

type Probe = {
  path: string;
  status: number;
  latencyMs: number;
  body: string;
  headers: Record<string, string>;
  error?: string;
};

type LogStep = {
  title: string;
  url: string;
  status: number | "NETWORK_ERROR";
  latency_ms: number;
  headers: Record<string, string>;
  error?: string;
  body?: unknown;
};

function asInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asFloat(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function jsonBody(probe: Probe, summarizeCatalog = false): unknown {
  const parsed = parseBody(probe.body);
  if (summarizeCatalog && parsed && typeof parsed === "object" && parsed !== null) {
    const data = (parsed as { data?: Array<{ id?: string }> }).data;
    if (Array.isArray(data)) return { model_count: data.length };
  }
  if (parsed !== null) return parsed;
  return probe.body || undefined;
}

function toStep(title: string, probe: Probe, summarizeCatalog = false): LogStep {
  const step: LogStep = {
    title,
    url: `${BASE}${probe.path}`,
    status: probe.status || "NETWORK_ERROR",
    latency_ms: probe.latencyMs,
    headers: probe.headers,
  };
  if (probe.error) step.error = probe.error;
  const body = jsonBody(probe, summarizeCatalog);
  if (body !== undefined) step.body = body;
  return step;
}

function formatLog(opts: {
  ok: boolean;
  error?: string;
  fingerprint: { chars: number; prefix: string };
  models: Record<string, string>;
  checks: Record<string, ConnectionCheck>;
  steps: LogStep[];
  extra?: Record<string, unknown>;
}): string {
  const payload: Record<string, unknown> = {
    title: "Conversation Bot · API test log",
    result: opts.ok ? "PASS" : "FAIL",
    time: new Date().toISOString(),
    probe: "server",
    provider: PROVIDER,
    key: {
      chars: opts.fingerprint.chars,
      prefix: opts.fingerprint.prefix,
    },
    models: opts.models,
    error: opts.error ?? null,
    steps: opts.steps,
    checks: Object.fromEntries(
      Object.entries(opts.checks).map(([id, row]) => [
        id,
        { label: row.label, result: row.ok ? "PASS" : "FAIL", detail: row.detail },
      ]),
    ),
    note: "The API secret is not included in this log.",
  };
  if (opts.extra) {
    for (const [key, value] of Object.entries(opts.extra)) payload[key] = value;
  }
  return JSON.stringify(payload, null, 2);
}

export function operatorError(err: unknown, apiKey = ""): string {
  const raw = redact(err instanceof Error ? err.message : String(err), apiKey);
  const low = raw.toLowerCase();
  if (low.includes("budget") || low.includes("cost limit")) {
    return "Council stopped because the configured cost limit was reached.";
  }
  if (low.includes("timeout") || low.includes("timed out") || low.includes("abort")) {
    return "One AI model did not respond in time. The Council run was stopped safely.";
  }
  if (
    low.includes("401") ||
    low.includes("403") ||
    low.includes("unauthorized") ||
    low.includes("invalid") ||
    low.includes("неверн")
  ) {
    return keyRejectedMessage(401, raw, keyFingerprint(apiKey, PROVIDER), PROVIDER);
  }
  if (low.includes("not currently available") || low.includes("unpublished") || low.includes("unknown model")) {
    return raw;
  }
  if (low.includes("not connected") || low.includes("api key") || low.includes("ключ")) {
    return "OpenRusRouter is not connected. Connect your API key before running the Council.";
  }
  return "The Council run was stopped. Check API Settings and try again.";
}

export async function preflightWithKey(opts: {
  apiKey: string;
  gptModel: string;
  grokModel: string;
  claudeModel: string;
}): Promise<PreflightClientReport & { pricing: Record<string, ModelPricing> }> {
  const checks: Record<string, ConnectionCheck> = {
    openrusrouter: { ok: false, label: "OpenRusRouter", detail: "Not checked" },
    gpt: { ok: false, label: "GPT Architect", detail: "Not checked" },
    grok: { ok: false, label: "Grok Adversary", detail: "Not checked" },
    claude: { ok: false, label: "Claude Formalist", detail: "Not checked" },
  };
  const models = {
    gpt: opts.gptModel.trim(),
    grok: opts.grokModel.trim(),
    claude: opts.claudeModel.trim(),
  };
  const key = sanitizeApiKey(opts.apiKey, PROVIDER);
  const fingerprint = keyFingerprint(key, PROVIDER);
  const steps: LogStep[] = [];
  const extra: Record<string, unknown> = {};
  const done = (ok: boolean, error: string | undefined, pricing: Record<string, ModelPricing> = {}) => ({
    ok,
    error,
    checks,
    models,
    pricing,
    log: formatLog({ ok, error, fingerprint, models, checks, steps, extra }),
  });

  if (!key) {
    const error = "OpenRusRouter is not connected. Connect your API key before running the Council.";
    checks.openrusrouter = { ok: false, label: "OpenRusRouter", detail: error };
    return done(false, error);
  }

  const modelsProbe = await probeGet("/models", key, 20000);
  steps.push(toStep("GET /v1/models", modelsProbe, true));

  if (modelsProbe.error) {
    const error = operatorError(modelsProbe.error, key);
    checks.openrusrouter = { ok: false, label: "OpenRusRouter", detail: error };
    return done(false, error);
  }

  if (modelsProbe.status === 401 || modelsProbe.status === 403) {
    const error = keyRejectedMessage(
      modelsProbe.status,
      extractErrorMessage(parseBody(modelsProbe.body), modelsProbe.status),
      fingerprint,
      PROVIDER,
    );
    checks.openrusrouter = { ok: false, label: "OpenRusRouter", detail: error };
    return done(false, error);
  }

  if (modelsProbe.status < 200 || modelsProbe.status >= 300) {
    const error = redact(extractErrorMessage(parseBody(modelsProbe.body), modelsProbe.status), key);
    checks.openrusrouter = { ok: false, label: "OpenRusRouter", detail: error };
    return done(false, error);
  }

  checks.openrusrouter = {
    ok: true,
    label: "OpenRusRouter",
    detail: `Connected · ${fingerprint.chars} characters`,
  };

  const catalog =
    (parseBody(modelsProbe.body) as { data?: Array<{ id?: string; pricing?: Record<string, string> }> } | null)?.data ??
    [];
  extra.catalog = { model_count: catalog.length };
  const known = new Set(catalog.map((m) => m.id).filter(Boolean) as string[]);
  const pricing: Record<string, ModelPricing> = {};
  const slots: Array<["gpt" | "grok" | "claude", string, string]> = [
    ["gpt", models.gpt, "GPT Architect"],
    ["grok", models.grok, "Grok Adversary"],
    ["claude", models.claude, "Claude Formalist"],
  ];
  const requested: Array<{ slot: string; id: string; result: string }> = [];
  for (const [slot, id, label] of slots) {
    if (!id) {
      checks[slot] = { ok: false, label, detail: `${label} model is missing.` };
      requested.push({ slot, id: "", result: "FAIL (empty)" });
      continue;
    }
    if (!known.has(id)) {
      checks[slot] = {
        ok: false,
        label,
        detail: `The selected ${label.replace(" Architect", "").replace(" Adversary", "").replace(" Formalist", "")} model is not currently available on OpenRusRouter. Choose another model in API Settings.`,
      };
      requested.push({ slot, id, result: "FAIL (not in catalog)" });
      continue;
    }
    const row = catalog.find((m) => m.id === id);
    pricing[id] = {
      prompt: asFloat(row?.pricing?.prompt),
      completion: asFloat(row?.pricing?.completion),
    };
    checks[slot] = { ok: true, label, detail: "Ready" };
    requested.push({ slot, id, result: "PASS" });
  }
  extra.requested_models = requested;

  const ok = Object.values(checks).every((c) => c.ok);
  const failed = Object.values(checks).find((c) => !c.ok);
  return done(ok, ok ? undefined : failed?.detail, pricing);
}

export async function complete(opts: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
}): Promise<Completion> {
  const key = sanitizeApiKey(opts.apiKey, PROVIDER);
  if (!key) throw new Error("OpenRusRouter is not connected. Connect your API key before running the Council.");
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;
  const started = Date.now();
  const retries = 2;
  let last = "OpenRusRouter request failed";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: headersFor(key, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      throw new Error(operatorError(err, key));
    }
    if (res.status === 429 || res.status >= 500) {
      last = `OpenRusRouter HTTP ${res.status}`;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const textBody = redact(await res.text(), key);
    const payload = parseBody(textBody);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        keyRejectedMessage(res.status, extractErrorMessage(payload, res.status), keyFingerprint(key, PROVIDER), PROVIDER),
      );
    }
    if (!res.ok) {
      throw new Error(operatorError(extractErrorMessage(payload, res.status), key));
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
  throw new Error(operatorError(last, key));
}
