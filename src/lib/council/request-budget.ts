import { attemptLimit, expectedSuccessfulCalls } from "./members.ts";

export const REQUEST_LIMIT_MESSAGE = "Council stopped because the request limit was reached.";

export type RequestBudget = {
  used: number;
  limit: number;
  expected: number;
};

export function emptyRequestBudget(memberCount = 3): RequestBudget {
  return {
    used: 0,
    limit: attemptLimit(memberCount),
    expected: expectedSuccessfulCalls(memberCount),
  };
}

export function createRequestCounter(memberCount = 3) {
  const limit = attemptLimit(memberCount);
  const expected = expectedSuccessfulCalls(memberCount);
  let used = 0;
  return {
    used: () => used,
    snapshot(): RequestBudget {
      return { used, limit, expected };
    },
    consume(stage: string): number {
      if (used >= limit) {
        throw new Error(`${REQUEST_LIMIT_MESSAGE} (${stage})`);
      }
      used += 1;
      return used;
    },
  };
}

export function isRequestLimitError(message: string): boolean {
  return /request limit was reached/i.test(message);
}

export function isEmptyCompletion(text: string | null | undefined): boolean {
  return !String(text ?? "").trim();
}

export { attemptLimit as MAX_PROVIDER_ATTEMPTS_FOR, expectedSuccessfulCalls as EXPECTED_SUCCESSFUL_CALLS_FOR };

export const MAX_PROVIDER_ATTEMPTS = attemptLimit(3);
export const EXPECTED_SUCCESSFUL_CALLS = expectedSuccessfulCalls(3);
