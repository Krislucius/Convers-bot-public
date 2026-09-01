import { redact } from "./api-key.ts";
import { providerName } from "./providers.ts";
import type { ProviderId } from "./types.ts";

export const COMPLETE_TIMEOUT_MS = 120_000;
export const PROVIDER_RETRY_LIMIT = 2;
export const PROVIDER_ATTEMPTS = PROVIDER_RETRY_LIMIT + 1;

export type HttpClass = "400" | "401" | "402" | "429" | "5xx" | "timeout" | "network" | "unknown";

export type ProviderFailure = {
  provider: ProviderId;
  model: string;
  stage: string;
  httpStatus: number | null;
  httpClass: HttpClass;
  retryExhausted: boolean;
  message: string;
};

export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderError";
    this.failure = failure;
  }
}

export function classifyHttp(status: number | null, raw = ""): HttpClass {
  const low = raw.toLowerCase();
  if (low.includes("timeout") || low.includes("timed out") || low.includes("abort") || low.includes("aborted")) {
    return "timeout";
  }
  if (
    status === 0 ||
    low.includes("network") ||
    low.includes("failed to fetch") ||
    low.includes("load failed") ||
    low.includes("econn")
  ) {
    return "network";
  }
  if (status === 400) return "400";
  if (status === 401 || status === 403) return "401";
  if (status === 402) return "402";
  if (status === 429) return "429";
  if (status != null && status >= 500) return "5xx";
  if (status === 400 || /\b400\b/.test(low)) return "400";
  if (/\b401\b/.test(low) || /\b403\b/.test(low)) return "401";
  if (/\b402\b/.test(low) || low.includes("credit") || low.includes("payment required")) return "402";
  if (/\b429\b/.test(low) || low.includes("rate limit")) return "429";
  if (/\b5\d\d\b/.test(low)) return "5xx";
  return "unknown";
}

export function httpClassOfStatus(status: number): HttpClass {
  if (status === 400) return "400";
  if (status === 401 || status === 403) return "401";
  if (status === 402) return "402";
  if (status === 429) return "429";
  if (status >= 500) return "5xx";
  if (status === 408) return "timeout";
  return "unknown";
}

export function isRetryableFailure(failure: Pick<ProviderFailure, "httpClass"> | null | undefined): boolean {
  return failure?.httpClass === "429" || failure?.httpClass === "5xx";
}

export function retryDelayMs(attempt: number): number {
  return 500 * 2 ** Math.max(0, attempt - 1);
}

function classLabel(httpClass: HttpClass, httpStatus: number | null): string {
  if (httpClass === "timeout") return "timeout";
  if (httpClass === "network") return "network error";
  if (httpClass === "5xx") return `HTTP ${httpStatus ?? 500}`;
  if (httpClass === "unknown") return httpStatus ? `HTTP ${httpStatus}` : "provider error";
  return `HTTP ${httpClass}`;
}

function classAdvice(httpClass: HttpClass): string {
  switch (httpClass) {
    case "400":
      return "The request was rejected.";
    case "401":
      return "Check API Settings and save a valid key.";
    case "402":
      return "Provider credits are exhausted.";
    case "429":
      return "Rate limited.";
    case "5xx":
      return "Provider error.";
    case "timeout":
      return `No response within ${COMPLETE_TIMEOUT_MS / 1000}s.`;
    case "network":
      return "The provider could not be reached.";
    default:
      return "The Council run was stopped.";
  }
}

export function formatProviderFailure(failure: ProviderFailure): string {
  const who = providerName(failure.provider);
  const model = failure.model.trim();
  const where = failure.stage.trim() || "request";
  const subject = model ? `${who} ${model}` : who;
  const code = classLabel(failure.httpClass, failure.httpStatus);
  const retry = failure.retryExhausted ? " (retries exhausted)" : "";
  return `${subject} failed in ${where}: ${code}${retry}. ${classAdvice(failure.httpClass)}`;
}

export function providerFailure(input: {
  provider: ProviderId;
  model: string;
  stage: string;
  httpStatus?: number | null;
  httpClass?: HttpClass;
  retryExhausted?: boolean;
  raw?: string;
}): ProviderFailure {
  const httpStatus = input.httpStatus ?? null;
  const httpClass = input.httpClass ?? classifyHttp(httpStatus, input.raw ?? "");
  const failure: ProviderFailure = {
    provider: input.provider,
    model: input.model,
    stage: input.stage,
    httpStatus,
    httpClass,
    retryExhausted: Boolean(input.retryExhausted),
    message: "",
  };
  failure.message = formatProviderFailure(failure);
  return failure;
}

export function toProviderFailure(
  err: unknown,
  ctx: { provider: ProviderId; model: string; stage: string },
  apiKey = "",
): ProviderFailure {
  if (err instanceof ProviderError) {
    return {
      ...err.failure,
      provider: err.failure.provider || ctx.provider,
      model: err.failure.model || ctx.model,
      stage: err.failure.stage || ctx.stage,
      message: formatProviderFailure({
        ...err.failure,
        provider: err.failure.provider || ctx.provider,
        model: err.failure.model || ctx.model,
        stage: err.failure.stage || ctx.stage,
      }),
    };
  }
  const raw = redact(err instanceof Error ? err.message : String(err), apiKey);
  const statusMatch = raw.match(/\b(40[0123]|429|408|5\d\d)\b/);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : null;
  return providerFailure({
    provider: ctx.provider,
    model: ctx.model,
    stage: ctx.stage,
    httpStatus,
    raw,
  });
}

export function containsSecret(text: string): boolean {
  return /sk-or-[A-Za-z0-9_-]{8,}|orr_(?:live|test)_[A-Za-z0-9_-]{8,}|Bearer\s+\S+/i.test(text);
}
