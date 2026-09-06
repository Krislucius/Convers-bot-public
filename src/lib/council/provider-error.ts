import { redact } from "./api-key.ts";
import { providerName } from "./providers.ts";
import type { ProviderId } from "./types.ts";

export const COMPLETE_TIMEOUT_MS = 120_000;
export const PROVIDER_RETRY_LIMIT = 2;
export const PROVIDER_ATTEMPTS = PROVIDER_RETRY_LIMIT + 1;

export const ERROR_CLASSES = [
  "HTTP_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "ABORTED",
  "STREAM_INTERRUPTED",
  "EMPTY_RESPONSE",
  "MODEL_UNAVAILABLE",
  "RATE_LIMITED",
  "PROVIDER_ERROR",
] as const;

export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Legacy HTTP family used for retry decisions. Never "unknown". */
export type HttpClass =
  | "400"
  | "401"
  | "402"
  | "429"
  | "5xx"
  | "timeout"
  | "network"
  | "empty"
  | "aborted"
  | "stream"
  | "http"
  | "provider";

export type ProviderFailure = {
  provider: ProviderId;
  model: string;
  stage: string;
  httpStatus: number | null;
  httpClass: HttpClass;
  errorClass: ErrorClass;
  attempt: number | null;
  maxAttempts: number | null;
  retryExhausted: boolean;
  message: string;
  detail?: string;
  code?: string;
  requestId?: string | null;
};

export class ProviderError extends Error {
  readonly failure: ProviderFailure;
  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderError";
    this.failure = failure;
  }
}

export function classifyErrorClass(
  status: number | null,
  raw = "",
  code?: string,
): { httpClass: HttpClass; errorClass: ErrorClass } {
  const low = raw.toLowerCase();
  const named = String(code ?? "").trim().toUpperCase();
  if (named === "MODEL_UNAVAILABLE" || named === "MODEL_NOT_INCLUDED") {
    return { httpClass: status != null && status >= 500 ? "5xx" : "http", errorClass: "MODEL_UNAVAILABLE" };
  }
  if (named === "RATE_LIMITED" || status === 429 || /\b429\b/.test(low) || low.includes("rate limit")) {
    return { httpClass: "429", errorClass: "RATE_LIMITED" };
  }
  if (low.includes("empty response") || low.includes("empty completion") || named === "EMPTY_RESPONSE") {
    return { httpClass: "empty", errorClass: "EMPTY_RESPONSE" };
  }
  if (
    low.includes("stream interrupted") ||
    low.includes("interrupted stream") ||
    low.includes("incomplete stream") ||
    named === "STREAM_INTERRUPTED"
  ) {
    return { httpClass: "stream", errorClass: "STREAM_INTERRUPTED" };
  }
  if (low.includes("timeout") || low.includes("timed out") || status === 408) {
    return { httpClass: "timeout", errorClass: "TIMEOUT" };
  }
  if (named === "ABORTED" || ((low.includes("abort") || low.includes("aborted")) && !low.includes("timeout"))) {
    return { httpClass: "aborted", errorClass: "ABORTED" };
  }
  if (
    status === 0 ||
    low.includes("network") ||
    low.includes("failed to fetch") ||
    low.includes("load failed") ||
    low.includes("econn")
  ) {
    return { httpClass: "network", errorClass: "NETWORK_ERROR" };
  }
  if (status === 400 || /\b400\b/.test(low)) return { httpClass: "400", errorClass: "HTTP_ERROR" };
  if (status === 401 || status === 403 || /\b401\b/.test(low) || /\b403\b/.test(low)) {
    return { httpClass: "401", errorClass: "HTTP_ERROR" };
  }
  if (status === 402 || /\b402\b/.test(low) || low.includes("credit") || low.includes("payment required")) {
    return { httpClass: "402", errorClass: "HTTP_ERROR" };
  }
  if ((status != null && status >= 500) || /\b5\d\d\b/.test(low)) {
    return { httpClass: "5xx", errorClass: "HTTP_ERROR" };
  }
  if (status != null && status > 0) return { httpClass: "http", errorClass: "HTTP_ERROR" };
  return { httpClass: "provider", errorClass: "PROVIDER_ERROR" };
}

export function classifyHttp(status: number | null, raw = ""): HttpClass {
  return classifyErrorClass(status, raw).httpClass;
}

export function httpClassOfStatus(status: number): HttpClass {
  return classifyErrorClass(status, "").httpClass;
}

export function isRetryableFailure(
  failure: Pick<ProviderFailure, "httpClass" | "errorClass"> | null | undefined,
): boolean {
  const errorClass = failure?.errorClass;
  if (
    errorClass === "RATE_LIMITED" ||
    errorClass === "TIMEOUT" ||
    errorClass === "NETWORK_ERROR" ||
    errorClass === "EMPTY_RESPONSE" ||
    errorClass === "STREAM_INTERRUPTED"
  ) {
    return true;
  }
  return (
    failure?.httpClass === "429" ||
    failure?.httpClass === "5xx" ||
    failure?.httpClass === "timeout" ||
    failure?.httpClass === "network" ||
    failure?.httpClass === "empty" ||
    failure?.httpClass === "stream"
  );
}

export function retryDelayMs(attempt: number): number {
  return 500 * 2 ** Math.max(0, attempt - 1);
}

function classLabel(failure: ProviderFailure): string {
  if (failure.errorClass === "TIMEOUT") return "timeout";
  if (failure.errorClass === "NETWORK_ERROR") return "network error";
  if (failure.errorClass === "EMPTY_RESPONSE") return "empty response";
  if (failure.errorClass === "ABORTED") return "aborted";
  if (failure.errorClass === "STREAM_INTERRUPTED") return "stream interrupted";
  if (failure.errorClass === "MODEL_UNAVAILABLE") return "model unavailable";
  if (failure.errorClass === "RATE_LIMITED") return failure.httpStatus ? `HTTP ${failure.httpStatus}` : "rate limited";
  if (failure.httpStatus) return `HTTP ${failure.httpStatus}`;
  return failure.errorClass.replaceAll("_", " ").toLowerCase();
}

function classAdvice(failure: ProviderFailure): string {
  if (failure.code === "PAYG_BALANCE_REQUIRED") return "Pay-as-you-go balance is required.";
  if (failure.code === "SUBSCRIPTION_LIMIT_REACHED") return "Subscription limit reached.";
  if (failure.code === "MODEL_NOT_INCLUDED") return "This model is not included in the selected billing mode.";
  if (failure.code === "MODEL_UNAVAILABLE") return "This model is unavailable.";
  if (failure.code === "RATE_LIMITED") return "Rate limited.";
  if (failure.code === "PROVIDER_ERROR") return "The request did not complete.";
  switch (failure.errorClass) {
    case "RATE_LIMITED":
      return "Rate limited.";
    case "TIMEOUT":
      return `No response within ${COMPLETE_TIMEOUT_MS / 1000}s.`;
    case "NETWORK_ERROR":
      return "The provider could not be reached.";
    case "EMPTY_RESPONSE":
      return "The provider returned no text.";
    case "ABORTED":
      return "The request was aborted.";
    case "STREAM_INTERRUPTED":
      return "The response stream was interrupted.";
    case "MODEL_UNAVAILABLE":
      return "This model is unavailable.";
    case "HTTP_ERROR":
      if (failure.httpClass === "401") return "Check API Settings and save a valid key.";
      if (failure.httpClass === "402") return "Payment was required.";
      if (failure.httpClass === "5xx") return "The provider returned a server error.";
      return "The request was rejected.";
    default:
      return "The request did not complete.";
  }
}

export function formatProviderFailure(failure: ProviderFailure): string {
  const who = providerName(failure.provider);
  const model = failure.model.trim();
  const where = failure.stage.trim() || "request";
  const subject = model ? `${who} ${model}` : who;
  const named = failure.code?.trim() ? `${failure.code.trim()} ` : "";
  const errorClass = failure.errorClass ?? "PROVIDER_ERROR";
  const code = classLabel({ ...failure, errorClass });
  const klass = ` class ${errorClass}`;
  const attempt =
    failure.attempt != null && failure.maxAttempts != null
      ? ` attempt ${failure.attempt}/${failure.maxAttempts}`
      : "";
  const retry = failure.retryExhausted ? " (retries exhausted)" : "";
  const requestId = failure.requestId?.trim() ? ` request_id ${failure.requestId.trim()}` : "";
  const detail = failure.detail?.trim();
  const extra = detail && !code.includes(detail) && !named.includes(detail) ? ` ${detail}` : "";
  return `${subject} failed in ${where}: ${named}${code}${klass}${attempt}${retry}.${requestId}${extra ? extra : ""} ${classAdvice(failure)}`
    .replace(/\s+/g, " ")
    .trim();
}

export function providerFailure(input: {
  provider: ProviderId;
  model: string;
  stage: string;
  httpStatus?: number | null;
  httpClass?: HttpClass;
  errorClass?: ErrorClass;
  attempt?: number | null;
  maxAttempts?: number | null;
  retryExhausted?: boolean;
  raw?: string;
  detail?: string;
  code?: string;
  requestId?: string | null;
}): ProviderFailure {
  const httpStatus = input.httpStatus ?? null;
  const classified = classifyErrorClass(httpStatus, input.raw ?? "", input.code);
  const httpClass = input.httpClass ?? classified.httpClass;
  const errorClass =
    input.errorClass ??
    (httpClass === "empty"
      ? "EMPTY_RESPONSE"
      : httpClass === "timeout"
        ? "TIMEOUT"
        : httpClass === "network"
          ? "NETWORK_ERROR"
          : httpClass === "aborted"
            ? "ABORTED"
            : httpClass === "stream"
              ? "STREAM_INTERRUPTED"
              : httpClass === "429"
                ? "RATE_LIMITED"
                : httpClass === "provider"
                  ? "PROVIDER_ERROR"
                  : classified.errorClass);
  const failure: ProviderFailure = {
    provider: input.provider,
    model: input.model,
    stage: input.stage,
    httpStatus,
    httpClass,
    errorClass,
    attempt: input.attempt ?? null,
    maxAttempts: input.maxAttempts ?? null,
    retryExhausted: Boolean(input.retryExhausted),
    message: "",
    detail: input.detail,
    code: input.code,
    requestId: input.requestId ?? null,
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
    const next = {
      ...err.failure,
      provider: err.failure.provider || ctx.provider,
      model: err.failure.model || ctx.model,
      stage: err.failure.stage || ctx.stage,
      errorClass: err.failure.errorClass ?? classifyErrorClass(err.failure.httpStatus, err.failure.detail ?? "").errorClass,
    };
    return {
      ...next,
      message: formatProviderFailure(next),
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
  return /sk-or-[A-Za-z0-9_-]{8,}|sk-nano-[A-Za-z0-9_-]{8,}|orr_(?:live|test)_[A-Za-z0-9_-]{8,}|Bearer\s+\S+/i.test(text);
}
