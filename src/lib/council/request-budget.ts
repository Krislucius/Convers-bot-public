import { attemptLimit, expectedSuccessfulCalls } from "./members.ts";

export const REQUEST_LIMIT_MESSAGE = "Council stopped because the request limit was reached.";

export type RequestKind = "PREFLIGHT" | "COUNCIL" | "RETRY";

export type RequestBudget = {
  used: number;
  limit: number;
  expected: number;
  preflightCalls: number;
  councilCalls: number;
  retries: number;
};

export function emptyRequestBudget(memberCount = 3): RequestBudget {
  return {
    used: 0,
    limit: attemptLimit(memberCount),
    expected: expectedSuccessfulCalls(memberCount),
    preflightCalls: 0,
    councilCalls: 0,
    retries: 0,
  };
}

export function createRequestCounter(memberCount = 3, initial?: Partial<RequestBudget> | number) {
  const limit = attemptLimit(memberCount);
  const expected = expectedSuccessfulCalls(memberCount);
  const seed = typeof initial === "number" ? { used: initial } : (initial ?? {});
  let used = Math.max(0, seed.used ?? 0);
  let preflightCalls = Math.max(0, seed.preflightCalls ?? 0);
  let councilCalls = Math.max(0, seed.councilCalls ?? 0);
  let retries = Math.max(0, seed.retries ?? 0);
  return {
    used: () => used,
    snapshot(): RequestBudget {
      return { used, limit, expected, preflightCalls, councilCalls, retries };
    },
    consume(stage: string, kind: RequestKind = "COUNCIL"): number {
      if (used >= limit) {
        throw new Error(`${REQUEST_LIMIT_MESSAGE} (${stage})`);
      }
      used += 1;
      if (kind === "PREFLIGHT") preflightCalls += 1;
      else if (kind === "RETRY") retries += 1;
      else councilCalls += 1;
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
