import { familyOf, isVerifiedAvailable, pruneToAvailable, type DiscoveredModel } from "./discover.ts";
import {
  COUNCIL_ROLES,
  DEFAULT_ROLES,
  ROLE_LABEL,
  isCouncilRole,
  type CouncilRole,
} from "./roles.ts";

export const MIN_COUNCIL_MEMBERS = 2;
export const MAX_COUNCIL_MEMBERS = 5;

export type CouncilMember = {
  memberId: string;
  role: CouncilRole;
  modelId: string;
  label: string;
  family: string;
};

export type MemberDraft = {
  memberId?: string;
  role?: CouncilRole | string;
  modelId: string;
  label?: string;
  family?: string;
};

export function newMemberId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `m_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }
  return `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function stableMemberId(modelId: string, index: number): string {
  const slug = modelId.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  return `legacy_${index}_${slug || "member"}`;
}

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

export function assertAvailableSelection(ids: string[], models: DiscoveredModel[]): string | null {
  const countError = assertCouncilSelection(ids);
  if (countError) return countError;
  const missing = ids.filter((id) => !models.some((row) => row.id === id && isVerifiedAvailable(row.access)));
  if (missing.length) {
    return `MODEL_UNAVAILABLE: ${missing.join(", ")} is not VERIFIED_AVAILABLE in the current scan. Refresh models and pick a replacement.`;
  }
  return null;
}

function roleForIndex(index: number, preferred?: string): CouncilRole {
  if (isCouncilRole(preferred)) return preferred;
  return COUNCIL_ROLES[index % COUNCIL_ROLES.length] ?? "ALTERNATIVE_REASONER";
}

/** Identity is memberId. Roles may repeat. Duplicate model ids are still dropped. */
export function ensureMembers(rows: MemberDraft[]): CouncilMember[] {
  const unique: MemberDraft[] = [];
  const seenModels = new Set<string>();
  for (const row of rows) {
    const modelId = String(row.modelId ?? "").trim();
    if (!modelId || seenModels.has(modelId)) continue;
    seenModels.add(modelId);
    unique.push({ ...row, modelId });
    if (unique.length === MAX_COUNCIL_MEMBERS) break;
  }
  const used = new Set<string>();
  return unique.map((row, index) => {
    let memberId = String(row.memberId ?? "").trim() || stableMemberId(row.modelId, index);
    while (used.has(memberId)) memberId = newMemberId();
    used.add(memberId);
    return {
      memberId,
      role: roleForIndex(index, row.role),
      modelId: row.modelId,
      label: String(row.label ?? "").trim() || row.modelId,
      family: String(row.family ?? "").trim() || familyOf(row.modelId),
    };
  });
}

export function assignRoles(
  models: Array<{
    id: string;
    name?: string;
    family?: string;
    score?: number;
    reasoning?: boolean;
    adversarial?: boolean;
    research?: boolean;
    coding?: boolean;
  }>,
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
  const lead = take((row) => Boolean(row.reasoning));
  if (lead) picked.push({ role: "LEAD_REASONER", model: lead });
  if (remaining.length) {
    const adv = take(
      (row) =>
        Boolean(row.adversarial) ||
        /\b(critic|adversarial|debate|audit|attack)\b/i.test(`${row.id} ${row.name ?? ""}`),
    );
    if (adv) picked.push({ role: "ADVERSARIAL", model: adv });
  }
  const restRoles = COUNCIL_ROLES.filter((role) => !picked.some((row) => row.role === role));
  while (remaining.length && picked.length < unique.length) {
    const role = restRoles[picked.length] ?? restRoles[restRoles.length - 1] ?? "ALTERNATIVE_REASONER";
    const next =
      role === "RESEARCH"
        ? take(
            (row) =>
              Boolean(row.research) ||
              /\b(sonar|search|research|browse|online)\b/i.test(`${row.id} ${row.name ?? ""}`),
          )
        : remaining.shift() ?? null;
    if (!next) break;
    picked.push({ role, model: next });
  }
  return ensureMembers(
    picked.slice(0, unique.length).map((row) => ({
      role: row.role,
      modelId: row.model.id,
      label: row.model.name?.trim() || row.model.id,
      family: row.model.family || familyOf(row.model.id),
    })),
  );
}

export function membersFromIds(
  ids: string[],
  catalog: DiscoveredModel[] = [],
): CouncilMember[] {
  const pruned = catalog.length ? pruneToAvailable(ids, catalog) : ids.map((id) => id.trim()).filter(Boolean);
  const byId = new Map(catalog.map((row) => [row.id, row]));
  return assignRoles(
    pruned.map((id) => {
      const hit = byId.get(id);
      return hit
        ? {
            id: hit.id,
            name: hit.name,
            family: hit.family,
            score: hit.score,
            reasoning: hit.reasoning,
            adversarial: Boolean(hit.capabilities?.adversarial),
            research: Boolean(hit.capabilities?.research),
            coding: Boolean(hit.capabilities?.coding),
          }
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
  members?: MemberDraft[] | null;
  selectedIds?: string[] | null;
  selectedModelIds?: string[] | null;
  gptModel?: string;
  grokModel?: string;
  claudeModel?: string;
  catalog?: DiscoveredModel[];
}): CouncilMember[] {
  const catalog = input.catalog ?? [];
  if (input.members && input.members.length) {
    const allowed = new Set(
      catalog.length
        ? pruneToAvailable(input.members.map((row) => row.modelId), catalog)
        : input.members.map((row) => row.modelId),
    );
    const kept = input.members.filter((row) => allowed.has(row.modelId.trim()));
    if (kept.length) return ensureMembers(kept);
  }
  const ids = (input.selectedIds ?? input.selectedModelIds ?? []).map((id) => id.trim()).filter(Boolean);
  if (ids.length) return membersFromIds(ids, catalog);
  return [];
}

export function memberLabel(member: CouncilMember): string {
  return `${ROLE_LABEL[member.role]} · ${member.label}`;
}

export function defaultRoleSet(count: number): CouncilRole[] {
  return COUNCIL_ROLES.slice(0, clampMemberCount(count));
}

export function findMember(
  members: CouncilMember[],
  row: { memberId?: string | null; agent?: string | null; model?: string | null },
): CouncilMember | undefined {
  const memberId = String(row.memberId ?? "").trim();
  if (memberId) {
    const hit = members.find((item) => item.memberId === memberId);
    if (hit) return hit;
  }
  const agent = String(row.agent ?? "").trim();
  if (agent) {
    const byId = members.find((item) => item.memberId === agent);
    if (byId) return byId;
    const byRole = members.filter((item) => item.role === agent);
    if (byRole.length === 1) return byRole[0];
  }
  const model = String(row.model ?? "").trim();
  if (model) {
    const byModel = members.filter((item) => item.modelId === model);
    if (byModel.length === 1) return byModel[0];
  }
  return undefined;
}

export { DEFAULT_ROLES };
