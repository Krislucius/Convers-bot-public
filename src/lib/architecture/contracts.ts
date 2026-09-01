/** Protected current-architecture contracts. Changing these requires an architecture revision bump. */

export const PROTECTED_INVARIANTS = [
  "ONE_AUTHORITATIVE_PROJECT",
  "TS_TANSTACK_NOT_PYTHON",
  "AUTH_ON_PER_ACCOUNT",
  "PROJECT_ISOLATION",
  "CREATE_REVIEW_DECIDE",
  "HISTORY_NOT_CANONICAL",
  "COUNCIL_THREE_AGENTS_TWO_ROUNDS",
  "KEYS_ACCOUNT_NOT_BROWSER",
  "NO_PARALLEL_GROK_APP",
  "SINGLE_CONTEXT_PACKER",
] as const;

export type ProtectedInvariant = (typeof PROTECTED_INVARIANTS)[number];

export const CURRENT_CONTEXT_PACKER = "evidenceLedgerPacker";
/** Canonical Council packet budget. Packing and estimates use countTokens(). */
export const CURRENT_CONTEXT_TOKEN_LIMIT = 6000;
/** Diagnostic only. Not the packer budget. */
export const CURRENT_CONTEXT_CHAR_LIMIT = 24000;
export const COUNCIL_ORCHESTRATOR_PATH = "src/lib/council/orchestrate.ts";
export const SUPERSEDED_PYTHON_TREE = "conversation-bot";
