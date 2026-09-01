import { completeChat as completeChatFn, testProvider as testProviderFn } from "./run-council";
import type { ProviderFailure } from "./provider-error";
import type { ChatMessage, Completion, PreflightClientReport, ProviderCreds, ProviderId } from "./types";

export async function testProvider(creds: ProviderCreds): Promise<PreflightClientReport> {
  return testProviderFn({ data: creds });
}

export async function completeChat(opts: {
  provider?: ProviderId;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  responseFormat?: Record<string, unknown>;
}): Promise<{ ok: true; completion: Completion } | { ok: false; error: string; failure?: ProviderFailure }> {
  return completeChatFn({ data: opts });
}