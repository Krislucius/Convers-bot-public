import {
  completeChat as completeChatFn,
  discoverModels as discoverModelsFn,
  testProvider as testProviderFn,
  checkAccess as checkAccessFn,
} from "./run-council";
import { providerFailure } from "./provider-error";
import type { ProviderFailure } from "./provider-error";
import type { ChatMessage, Completion, PreflightClientReport, ProviderCreds, ProviderId } from "./types";
import type { DiscoverySnapshot } from "./discover";
import type { NanoGptBillingMode } from "./nano-billing";

export async function testProvider(creds: ProviderCreds): Promise<PreflightClientReport> {
  return testProviderFn({ data: creds });
}

export async function discoverModels(opts: {
  provider?: ProviderId;
  apiKey?: string;
  selectedIds?: string[];
  nanogptBilling?: NanoGptBillingMode;
}): Promise<{
  ok: boolean;
  error?: string;
  catalog: DiscoverySnapshot | null;
  checks: PreflightClientReport["checks"];
  log: string;
}> {
  return discoverModelsFn({ data: opts });
}

export async function checkAccess(opts: {
  provider?: ProviderId;
  apiKey?: string;
  models: string[];
  nanogptBilling?: NanoGptBillingMode;
}): Promise<{ ok: boolean; blocked: Array<{ id: string; access: string }>; error?: string }> {
  return checkAccessFn({ data: opts });
}

function abortedResult(opts: { provider?: ProviderId; model: string; stage?: string }): {
  ok: false;
  error: string;
  failure: ProviderFailure;
} {
  const failure = providerFailure({
    provider: opts.provider ?? "nanogpt",
    model: opts.model,
    stage: opts.stage ?? "complete",
    httpClass: "aborted",
    errorClass: "ABORTED",
    raw: "Council run stopped.",
  });
  failure.message = "Council run stopped.";
  return { ok: false, error: failure.message, failure };
}

export async function completeChat(opts: {
  provider?: ProviderId;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
  nanogptBilling?: NanoGptBillingMode;
}): Promise<{ ok: true; completion: Completion } | { ok: false; error: string; failure?: ProviderFailure }> {
  const { signal, ...data } = opts;
  if (signal?.aborted) return abortedResult(opts);
  const pending = completeChatFn({ data });
  if (!signal) return pending;
  return await new Promise((resolve, reject) => {
    const onAbort = () => resolve(abortedResult(opts));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(signal.aborted ? abortedResult(opts) : value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) resolve(abortedResult(opts));
        else reject(err);
      },
    );
  });
}
