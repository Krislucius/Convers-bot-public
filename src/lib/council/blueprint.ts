import { isVerifiedAvailable, type DiscoveredModel } from "./discover.ts";
import { ensureMembers, MAX_COUNCIL_MEMBERS, MIN_COUNCIL_MEMBERS, type CouncilMember } from "./members.ts";
import { COUNCIL_ROLES, type CouncilRole } from "./roles.ts";
import type { ProviderId } from "./types.ts";

export const COUNCIL_BLUEPRINT = {
  id: "CB-COUNCIL-BLUEPRINT-001",
  requiredRoles: [...COUNCIL_ROLES] as CouncilRole[],
  minMembers: MIN_COUNCIL_MEMBERS,
  maxMembers: MAX_COUNCIL_MEMBERS,
  synthesis: "One synthesizer after round 2. The JSON schema is authoritative.",
  continuation: "2-of-N surviving members may continue. Roles are not dropped to keep a provider.",
  oneProviderPerRun: true,
} as const;

export type BlueprintMatch = {
  ok: boolean;
  blueprintId: string;
  members: CouncilMember[];
  missingRoles: CouncilRole[];
  provider: ProviderId | null;
};

function prefer(role: CouncilRole, row: DiscoveredModel): boolean {
  const caps = row.capabilities;
  const name = `${row.id} ${row.name}`.toLowerCase();
  if (role === "LEAD_REASONER") return Boolean(row.reasoning || caps?.reasoning);
  if (role === "ADVERSARIAL") return Boolean(caps?.adversarial) || /\b(critic|adversarial|debate|audit|attack|grok)\b/.test(name);
  if (role === "FORMAL_REVIEW") return Boolean(caps?.coding || caps?.reasoning || row.reasoning);
  if (role === "RESEARCH") return Boolean(caps?.research) || /\b(sonar|search|research|browse|online)\b/.test(name);
  return true;
}

export function matchBlueprint(models: DiscoveredModel[], provider: ProviderId | null = null): BlueprintMatch {
  const verified = models
    .filter((row) => row.id.trim() && isVerifiedAvailable(row.access))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
  const remaining = [...verified];
  const picked: Array<{ role: CouncilRole; model: DiscoveredModel }> = [];
  for (const role of COUNCIL_BLUEPRINT.requiredRoles) {
    const index = remaining.findIndex((row) => prefer(role, row));
    const model = index >= 0 ? remaining.splice(index, 1)[0] : remaining.shift();
    if (!model) break;
    picked.push({ role, model });
  }
  const filled = new Set(picked.map((row) => row.role));
  const missingRoles = COUNCIL_BLUEPRINT.requiredRoles.filter((role) => !filled.has(role));
  const members = ensureMembers(
    picked.map((row) => ({
      role: row.role,
      modelId: row.model.id,
      label: row.model.name?.trim() || row.model.id,
      family: row.model.family,
    })),
  );
  return {
    ok: missingRoles.length === 0 && members.length === COUNCIL_BLUEPRINT.requiredRoles.length,
    blueprintId: COUNCIL_BLUEPRINT.id,
    members,
    missingRoles,
    provider,
  };
}

export function sameRoleSequence(left: CouncilMember[], right: CouncilMember[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row.role === right[index]?.role);
}

export type RunComposition = {
  provider: ProviderId;
  members: CouncilMember[];
  match: BlueprintMatch | null;
  readyToRun: boolean;
  failure: "PROVIDER_CANNOT_ASSEMBLE" | "PROVIDER_CATALOG_REQUIRED" | null;
};

export function resolveRunComposition(input: {
  taskProvider: ProviderId | null | undefined;
  settingsProvider: ProviderId;
  catalog: { provider: string; models: DiscoveredModel[] } | null;
  fallbackMembers: CouncilMember[];
}): RunComposition {
  const provider = input.taskProvider ?? input.settingsProvider;
  if (input.catalog && input.catalog.provider === provider) {
    const match = matchBlueprint(input.catalog.models, provider);
    return {
      provider,
      members: match.members,
      match,
      readyToRun: match.ok,
      failure: match.ok ? null : "PROVIDER_CANNOT_ASSEMBLE",
    };
  }
  if (input.taskProvider && input.taskProvider !== input.settingsProvider) {
    return {
      provider,
      members: [],
      match: null,
      readyToRun: false,
      failure: "PROVIDER_CATALOG_REQUIRED",
    };
  }
  const members = input.fallbackMembers;
  const ready = members.length >= COUNCIL_BLUEPRINT.minMembers;
  return {
    provider,
    members,
    match: null,
    readyToRun: ready,
    failure: ready ? null : "PROVIDER_CANNOT_ASSEMBLE",
  };
}
