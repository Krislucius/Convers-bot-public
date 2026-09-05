import { familyOf } from "./discover.ts";
import {
  COUNCIL_ROLES,
  DEFAULT_ROLES,
  ROLE_LABEL,
  type CouncilRole,
} from "./roles.ts";
import type { DiscoveredModel } from "./discover.ts";

export const MIN_COUNCIL_MEMBERS = 2;
export const MAX_COUNCIL_MEMBERS = 5;

export type CouncilMember = {
  role: CouncilRole;
  modelId: string;
  label: string;
  family: string;
};

export function clampMemberCount(n: number): number {
  if (!Number.isFinite(n) || n < MIN_COUNCIL_MEMBERS) return MIN_COUNCIL_MEMBERS;
  if (n > MAX_COUNCIL_MEMBERS) return MAX_COUNCIL_MEMBERS;
  return Math.trunc(n);
}

export function expectedSuccessfulCalls(memberCount: number): number {
  return 2 * clampMemberCount(memberCount) + 1;
}

export function attemptLimit(memberCount: number): number {
  const n = clampMemberCount(memberCount);
  return expectedSuccessfulCalls(n) + n + 2;
}

export function assertCouncilSelection(ids: string[]): string | null {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length < MIN_COUNCIL_MEMBERS) {
    return `Select at least ${MIN_COUNCIL_MEMBERS} Council models.`;
  }
  if (unique.length > MAX_COUNCIL_MEMBERS) {
    return `Select at most ${MAX_COUNCIL_MEMBERS} Council models.`;
  }
  return null;
}

export function assignRoles(
  models: Array<{ id: string; name?: string; family?: string; score?: number; reasoning?: boolean }>,
): CouncilMember[] {
  const unique: typeof models = [];
  const seen = new Set<string>();
  for (const row of models) {
    const id = row.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(row);
    if (unique.length === MAX_COUNCIL_MEMBERS) break;
  }
  const sorted = [...unique].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const remaining = [...sorted];
  const take = (pred: (row: (typeof sorted)[number]) => boolean) => {
    const index = remaining.findIndex(pred);
    if (index < 0) return remaining.shift() ?? null;
    return remaining.splice(index, 1)[0] ?? null;
  };
  const picked: Array<{ role: CouncilRole; model: (typeof sorted)[number] }> = [];
  const lead = take((row) => Boolean(row.reasoning) || familyOf(row.id, row.family) === "anthropic" || familyOf(row.id, row.family) === "openai");
  if (lead) picked.push({ role: "LEAD_REASONER", model: lead });
  if (remaining.length) {
    const adv = take((row) => {
      const family = familyOf(row.id, row.family);
      return family === "xai" || family === "deepseek" || family === "perplexity" || family === "kimi";
    });
    if (adv) picked.push({ role: "ADVERSARIAL", model: adv });
  }
  const restRoles = COUNCIL_ROLES.filter((role) => !picked.some((row) => row.role === role));
  while (remaining.length && picked.length < unique.length) {
    const role = restRoles[picked.length] ?? restRoles[restRoles.length - 1];
    const next =
      role === "RESEARCH"
        ? take((row) => familyOf(row.id, row.family) === "perplexity" || familyOf(row.id, row.family) === "kimi")
        : role === "FORMAL_REVIEW"
          ? take((row) => familyOf(row.id, row.family) === "anthropic" || familyOf(row.id, row.family) === "openai")
          : remaining.shift() ?? null;
    if (!next) break;
    picked.push({ role, model: next });
  }
  return picked.slice(0, unique.length).map((row) => ({
    role: row.role,
    modelId: row.model.id,
    label: row.model.name?.trim() || row.model.id,
    family: row.model.family || familyOf(row.model.id),
  }));
}

export function membersFromIds(
  ids: string[],
  catalog: DiscoveredModel[] = [],
): CouncilMember[] {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  return assignRoles(
    ids.map((id) => {
      const hit = byId.get(id);
      return hit
        ? { id: hit.id, name: hit.name, family: hit.family, score: hit.score, reasoning: hit.reasoning }
        : { id, name: id, family: familyOf(id), score: 0, reasoning: false };
    }),
  );
}

export function membersFromLegacy(gpt: string, grok: string, claude: string): CouncilMember[] {
  return assignRoles(
    [
      { id: gpt, name: gpt, family: familyOf(gpt), score: 90, reasoning: true },
      { id: grok, name: grok, family: familyOf(grok), score: 80, reasoning: true },
      { id: claude, name: claude, family: familyOf(claude), score: 88, reasoning: true },
    ].filter((row) => row.id.trim()),
  );
}

export function coerceMembers(input: {
  members?: CouncilMember[] | null;
  selectedIds?: string[] | null;
  selectedModelIds?: string[] | null;
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  catalog?: DiscoveredModel[];
}): CouncilMember[] {
  if (input.members && input.members.length) {
    const seen = new Set<string>();
    const unique = input.members.filter((row) => {
      const id = row.modelId?.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return unique.slice(0, MAX_COUNCIL_MEMBERS);
  }
  const ids = (input.selectedIds ?? input.selectedModelIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length) return membersFromIds(ids, input.catalog ?? []);
  return membersFromLegacy(input.gptModel ?? "", input.grokModel ?? "", input.claudeModel ?? "");
}

export function memberLabel(member: CouncilMember): string {
  return `${ROLE_LABEL[member.role]} · ${member.label}`;
}

export function defaultRoleSet(count: number): CouncilRole[] {
  return COUNCIL_ROLES.slice(0, clampMemberCount(count));
}

export { DEFAULT_ROLES };
