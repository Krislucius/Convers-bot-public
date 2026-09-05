/** Dynamic Council roles. These are guidance, not vendor identities. */

export const COUNCIL_ROLES = [
  "LEAD_REASONER",
  "ADVERSARIAL",
  "FORMAL_REVIEW",
  "RESEARCH",
  "ALTERNATIVE_REASONER",
] as const;

export type CouncilRole = (typeof COUNCIL_ROLES)[number];
export type AgentKey = CouncilRole;

export const DEFAULT_ROLES: CouncilRole[] = ["LEAD_REASONER", "ADVERSARIAL", "FORMAL_REVIEW"];

export const ROLE_LABEL: Record<CouncilRole, string> = {
  LEAD_REASONER: "Lead reasoner",
  ADVERSARIAL: "Adversarial",
  FORMAL_REVIEW: "Formal review",
  RESEARCH: "Research",
  ALTERNATIVE_REASONER: "Alternative reasoner",
};

const LEGACY: Record<string, CouncilRole> = {
  GPT: "LEAD_REASONER",
  GROK: "ADVERSARIAL",
  CLAUDE: "FORMAL_REVIEW",
  gpt: "LEAD_REASONER",
  grok: "ADVERSARIAL",
  claude: "FORMAL_REVIEW",
  LEAD: "LEAD_REASONER",
  ADVERSARY: "ADVERSARIAL",
  FORMALIST: "FORMAL_REVIEW",
};

export function isCouncilRole(value: unknown): value is CouncilRole {
  return typeof value === "string" && (COUNCIL_ROLES as readonly string[]).includes(value);
}

export function normalizeAgentKey(value: string | null | undefined): CouncilRole {
  const raw = String(value ?? "").trim();
  if (isCouncilRole(raw)) return raw;
  return LEGACY[raw] ?? LEGACY[raw.toUpperCase()] ?? "LEAD_REASONER";
}

export function roleLabel(role: string): string {
  return isCouncilRole(role) ? ROLE_LABEL[role] : role;
}

const TAXONOMY = `Severity taxonomy (mandatory):
P0 = invariant / frozen contract violation
P1 = architecture or fundamental logical flaw
P2 = correctness defect
P3 = robustness / edge-case issue
P4 = optimization / style / optional improvement

Return EXACTLY these headings, in this order, as plain text (not JSON):
POSITION
P0_BLOCKERS
P1_ARCHITECTURE
P2_CORRECTNESS
P3_ROBUSTNESS
P4_IMPROVEMENTS
RECOMMENDATION

If a section has no items write "none".
Do not execute tools, shell, or code. You produce review text only.`;

export function rolePrompt(role: CouncilRole, mode: "CREATE" | "REVIEW" | "DECIDE"): string {
  const duty = DUTY[role];
  if (mode === "CREATE") {
    return `You are the ${ROLE_LABEL[role]} in CREATE mode. ${duty.create} ${TAXONOMY}`;
  }
  if (mode === "DECIDE") {
    return `You are the ${ROLE_LABEL[role]} in DECIDE mode. ${duty.decide} ${TAXONOMY}`;
  }
  return `You are the ${ROLE_LABEL[role]}. ${duty.review} ${TAXONOMY}`;
}

const DUTY: Record<CouncilRole, { create: string; review: string; decide: string }> = {
  LEAD_REASONER: {
    create:
      "Reconstruct architecture from supplied evidence. Identify authoritative decisions, contradictions, a canonical structure, and P0/P1 uncertainty. Absence of a pre-existing candidate document is expected — you are producing the artifact, not reviewing one. Do not BLOCK merely because no candidate existed before this run. Repository/runtime absence means implementation status = UNKNOWN, not that the whole CREATE task is blocked.",
    review: "Judge whether the proposal fits the frozen architecture. Lead the reconstruction of a coherent position.",
    decide: "Answer the bounded decision question. Return a clear position, rationale, and residual P0/P1 concerns.",
  },
  ADVERSARIAL: {
    create:
      "Challenge reconstructed assumptions, mark obsolete/superseded interpretations, identify missing evidence, and attack the proposed architecture. Do not reject CREATE because no candidate document existed beforehand. Missing repository evidence is UNKNOWN implementation status, not a reason to BLOCK the entire specification.",
    review: "Hunt for hidden assumptions, invariant violations, and weak evidence. Attack the default.",
    decide: "Attack the implied default, surface dissent, and name what remains unresolved.",
  },
  FORMAL_REVIEW: {
    create:
      "Normalize terminology, flag ambiguous contracts, inconsistent states, and underspecified interfaces. You are not merely reviewing a nonexistent artifact. Cite evidence as [CHAT:source_id:message_sequence] when available.",
    review: "Check that claims follow from the frozen text. Flag inconsistency and missing contracts.",
    decide: "Check that the decision is stated as a contract, with unambiguous terms and failure modes.",
  },
  RESEARCH: {
    create:
      "Ground the reconstruction in the supplied sources. Call out missing citations, competing accounts, and what would need to be verified. Do not invent repository evidence.",
    review: "Cross-check claims against the packed evidence. Prefer cited fact over confidence.",
    decide: "Map each option to the evidence. Name what is unknown rather than filling gaps.",
  },
  ALTERNATIVE_REASONER: {
    create:
      "Propose a genuine alternative architecture if the leading reconstruction is not the only coherent reading. If you agree, say so explicitly and tighten the leading view.",
    review: "Offer an independent reading. Agreement is allowed; unexamined agreement is not.",
    decide: "State a second-best option and the conditions under which it would win.",
  },
};
