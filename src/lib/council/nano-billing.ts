/** NanoGPT subscription vs pay-as-you-go are separate APIs. Never mix them in one run. */

export type NanoGptBillingMode = "subscription" | "payg";

export const DEFAULT_NANOGPT_BILLING: NanoGptBillingMode = "subscription";

export const NANOGPT_HOST = "https://nano-gpt.com";
export const NANOGPT_PAYG_BASE = `${NANOGPT_HOST}/api/v1`;
export const NANOGPT_SUBSCRIPTION_BASE = `${NANOGPT_HOST}/api/subscription/v1`;

export const NANOGPT_PAYG_MODELS_URL = `${NANOGPT_PAYG_BASE}/models`;
export const NANOGPT_PAYG_COMPLETE_URL = `${NANOGPT_PAYG_BASE}/chat/completions`;
export const NANOGPT_SUBSCRIPTION_MODELS_URL = `${NANOGPT_SUBSCRIPTION_BASE}/models?detailed=true`;
export const NANOGPT_SUBSCRIPTION_COMPLETE_URL = `${NANOGPT_SUBSCRIPTION_BASE}/chat/completions`;
export const NANOGPT_SUBSCRIPTION_USAGE_URL = `${NANOGPT_SUBSCRIPTION_BASE}/usage`;

export type NanoGptErrorCode =
  | "PAYG_BALANCE_REQUIRED"
  | "SUBSCRIPTION_LIMIT_REACHED"
  | "MODEL_NOT_INCLUDED"
  | "MODEL_UNAVAILABLE"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR";

export type NanoGptEndpoints = {
  billing: NanoGptBillingMode;
  catalogUrl: string;
  completeUrl: string;
  usageUrl: string | null;
};

export function isNanoGptBillingMode(value: unknown): value is NanoGptBillingMode {
  return value === "subscription" || value === "payg";
}

export function normalizeNanoGptBilling(value: unknown): NanoGptBillingMode {
  return isNanoGptBillingMode(value) ? value : DEFAULT_NANOGPT_BILLING;
}

/** Explicit PAYG wins. Otherwise Subscription — never auto-fall back to PAYG. */
export function resolveNanoGptBilling(opts: {
  explicit?: unknown;
  subscriptionCatalogAvailable?: boolean;
}): NanoGptBillingMode {
  if (opts.explicit === "payg") return "payg";
  if (opts.explicit === "subscription") return "subscription";
  if (opts.subscriptionCatalogAvailable === false && opts.explicit === "payg") return "payg";
  return DEFAULT_NANOGPT_BILLING;
}

export function billingLabel(mode: NanoGptBillingMode | null | undefined): string {
  if (mode === "payg") return "PAYG";
  return "SUBSCRIPTION";
}

export function nanogptEndpoints(mode: NanoGptBillingMode = DEFAULT_NANOGPT_BILLING): NanoGptEndpoints {
  if (mode === "payg") {
    return {
      billing: "payg",
      catalogUrl: NANOGPT_PAYG_MODELS_URL,
      completeUrl: NANOGPT_PAYG_COMPLETE_URL,
      usageUrl: null,
    };
  }
  return {
    billing: "subscription",
    catalogUrl: NANOGPT_SUBSCRIPTION_MODELS_URL,
    completeUrl: NANOGPT_SUBSCRIPTION_COMPLETE_URL,
    usageUrl: NANOGPT_SUBSCRIPTION_USAGE_URL,
  };
}

export function isSubscriptionUrl(url: string): boolean {
  return url.includes("/api/subscription/v1/");
}

export function isPaygUrl(url: string): boolean {
  return url.includes("/api/v1/") && !isSubscriptionUrl(url);
}

export function urlsForBilling(mode: NanoGptBillingMode, urls: string[]): string[] {
  return urls.filter((url) => (mode === "subscription" ? isSubscriptionUrl(url) : isPaygUrl(url)));
}

export function mixedBillingUrls(mode: NanoGptBillingMode, urls: string[]): string[] {
  return urls.filter((url) => (mode === "subscription" ? isPaygUrl(url) : isSubscriptionUrl(url)));
}

export function assertSingleBilling(mode: NanoGptBillingMode, urls: string[]): void {
  const leaked = mixedBillingUrls(mode, urls);
  if (leaked.length) {
    throw new Error(
      mode === "subscription"
        ? `PAYG fallback: ${leaked.join(", ")}`
        : `Subscription mix: ${leaked.join(", ")}`,
    );
  }
}

export function paygOnlyIds(selectedIds: string[], subscriptionIds: Iterable<string>): string[] {
  const allowed = new Set([...subscriptionIds].map((id) => id.trim()).filter(Boolean));
  return [...new Set(selectedIds.map((id) => id.trim()).filter(Boolean))].filter((id) => !allowed.has(id));
}

export function classifyNanoGptError(opts: {
  billing: NanoGptBillingMode;
  status: number;
  raw?: string;
}): NanoGptErrorCode {
  const raw = `${opts.raw ?? ""}`.toLowerCase();
  if (
    opts.status === 403 ||
    /not included|not (?:in|on) (?:your )?subscription|no access to this model|model not (?:allowed|enabled)|permission denied for model|model_not_allowed/.test(
      raw,
    )
  ) {
    return "MODEL_NOT_INCLUDED";
  }
  if (opts.status === 404 || /model[_ ]?not[_ ]?found|unknown model|invalid model|model_not_available/.test(raw)) {
    return "MODEL_UNAVAILABLE";
  }
  if (opts.status === 429 || /rate.?limit/.test(raw)) return "RATE_LIMITED";
  if (
    opts.status === 402 ||
    /insufficient.?credit|payment required|add balance|quota|limit reached|out of (?:quota|allowance)/.test(raw)
  ) {
    return opts.billing === "subscription" ? "SUBSCRIPTION_LIMIT_REACHED" : "PAYG_BALANCE_REQUIRED";
  }
  return "PROVIDER_ERROR";
}

export function nanoGptErrorAdvice(code: NanoGptErrorCode): string {
  switch (code) {
    case "PAYG_BALANCE_REQUIRED":
      return "Pay-as-you-go balance is required.";
    case "SUBSCRIPTION_LIMIT_REACHED":
      return "Subscription limit reached.";
    case "MODEL_NOT_INCLUDED":
      return "This model is not included in the selected billing mode.";
    case "MODEL_UNAVAILABLE":
      return "This model is unavailable.";
    case "RATE_LIMITED":
      return "Rate limited.";
    default:
      return "The request did not complete.";
  }
}

export function formatNanoGptError(opts: {
  code: NanoGptErrorCode;
  status: number | null;
  providerMessage?: string;
}): string {
  const status = opts.status != null && opts.status > 0 ? ` HTTP ${opts.status}` : "";
  const detail = opts.providerMessage?.trim();
  const extra = detail && !opts.code.includes(detail) ? ` ${detail}` : "";
  return `${opts.code}${status}.${extra} ${nanoGptErrorAdvice(opts.code)}`.replace(/\s+/g, " ").trim();
}

export function forbiddenSubscriptionExhaustionPhrase(text: string): boolean {
  return /subscription credits exhausted/i.test(text);
}
