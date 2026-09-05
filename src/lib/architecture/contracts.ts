/** Protected current-architecture contracts. Changing these requires an architecture revision. */

export const PROTECTED_INVARIANTS = [
  "ONE_AUTHORITATIVE_PROJECT",
  "TS_TANSTACK_NOT_PYTHON",
  "AUTH_ON_PER_ACCOUNT",
  "PROJECT_ISOLATION",
  "CREATE_REVIEW_DECIDE",
  "HISTORY_NOT_CANONICAL",
  "COUNCIL_DYNAMIC_MEMBERS_TWO_ROUNDS",
  "KEYS_ACCOUNT_NOT_BROWSER",
  "NO_PARALLEL_GROK_APP",
  "SINGLE_CONTEXT_PACKER",
  "IMPLEMENTATION_PACKET_HANDOFF",
  "SINGLE_PROVIDER_PER_RUN",
  "REQUEST_BUDGET_NOT_USD_GATE",
  "COUNCIL_AVAILABLE_SCAN_ONLY",
  "COUNCIL_VERIFIED_SELECTED_PREFLIGHT",
] as const;

export type ProtectedInvariant = (typeof PROTECTED_INVARIANTS)[number];

export const CURRENT_CONTEXT_PACKER = "evidenceLedgerPacker";
/** Canonical Council packet budget. Packing and estimates use countTokens(). */
export const CURRENT_CONTEXT_TOKEN_LIMIT = 6000;
/** Diagnostic only. Not the packer budget. */
export const CURRENT_CONTEXT_CHAR_LIMIT = 24000;
export const CURRENT_EXPECTED_COUNCIL_CALLS = 7;
export const CURRENT_REQUEST_ATTEMPT_LIMIT = 12;
export const COUNCIL_ORCHESTRATOR_PATH = "src/lib/council/orchestrate.ts";
export const SUPERSEDED_PYTHON_TREE = "conversation-bot";
