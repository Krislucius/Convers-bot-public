import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiscoveredModel } from "./discover.ts";
import { COUNCIL_BLUEPRINT, matchBlueprint, resolveRunComposition, sameRoleSequence } from "./blueprint.ts";
import type { CouncilMember } from "./members.ts";

function caps(partial: Partial<NonNullable<DiscoveredModel["capabilities"]>>): NonNullable<DiscoveredModel["capabilities"]> {
  return {
    reasoning: false,
    coding: false,
    longContext: true,
    research: false,
    adversarial: false,
    reliability: 1,
    contextTokens: 128000,
    ...partial,
  };
}

function model(id: string, score: number, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id,
    name: id,
    family: "other",
    access: "VERIFIED_AVAILABLE",
    recommendedRole: null,
    contextTokens: 128000,
    reasoning: true,
    score,
    probed: true,
    ...extra,
  };
}

const nano = [
  model("kimi", 90, { capabilities: caps({ reasoning: true, coding: true }) }),
  model("qwen", 80, { name: "Qwen critic", capabilities: caps({ reasoning: true, adversarial: true }) }),
  model("formal", 70, { capabilities: caps({ reasoning: true, coding: true }) }),
  model("sonar", 60, { name: "sonar research", reasoning: false, capabilities: caps({ research: true }) }),
  model("alt", 50, { capabilities: caps({ reasoning: true }) }),
];

const open = [
  model("or-lead", 99),
  model("or-critic", 88, { name: "audit critic" }),
  model("or-formal", 77),
  model("or-search", 66, { name: "online search" }),
  model("or-alt", 55),
];

describe("council blueprint", () => {
  it("keeps the same roles when the provider changes and only remaps models", () => {
    const nanoMatch = matchBlueprint(nano, "nanogpt");
    const openMatch = matchBlueprint(open, "openrouter");
    const back = matchBlueprint(nano, "nanogpt");
    assert.equal(nanoMatch.ok, true);
    assert.equal(openMatch.ok, true);
    assert.equal(sameRoleSequence(nanoMatch.members, openMatch.members), true);
    assert.deepEqual(nanoMatch.members.map((row) => row.role), [...COUNCIL_BLUEPRINT.requiredRoles]);
    assert.notDeepEqual(
      nanoMatch.members.map((row) => row.modelId),
      openMatch.members.map((row) => row.modelId),
    );
    assert.deepEqual(
      back.members.map((row) => row.modelId),
      nanoMatch.members.map((row) => row.modelId),
    );
    assert.equal(new Set([...nanoMatch.members, ...openMatch.members].map((row) => row.modelId)).size, 10);
  });

  it("fails closed when a provider cannot fill one required role", () => {
    const match = matchBlueprint(nano.slice(0, 4), "openrouter");
    assert.equal(match.ok, false);
    assert.equal(match.missingRoles.length, 1);
    assert.equal(match.members.length, 4);
    assert.equal(match.members.some((row) => row.role === match.missingRoles[0]), false);
    const resolved = resolveRunComposition({
      taskProvider: "openrouter",
      settingsProvider: "nanogpt",
      catalog: { provider: "openrouter", models: nano.slice(0, 4) },
      fallbackMembers: match.members,
    });
    assert.equal(resolved.failure, "PROVIDER_CANNOT_ASSEMBLE");
    assert.equal(resolved.readyToRun, false);
    assert.equal(resolved.provider, "openrouter");
  });

  it("does not reuse another provider catalog and does not mix providers in one run", () => {
    const nanoMatch = matchBlueprint(nano, "nanogpt");
    const blocked = resolveRunComposition({
      taskProvider: "openrouter",
      settingsProvider: "nanogpt",
      catalog: { provider: "nanogpt", models: nano },
      fallbackMembers: nanoMatch.members,
    });
    assert.equal(blocked.failure, "PROVIDER_CATALOG_REQUIRED");
    assert.deepEqual(blocked.members, []);
    const switched = resolveRunComposition({
      taskProvider: "openrouter",
      settingsProvider: "nanogpt",
      catalog: { provider: "openrouter", models: open },
      fallbackMembers: [] as CouncilMember[],
    });
    assert.equal(switched.readyToRun, true);
    assert.equal(switched.provider, "openrouter");
    assert.equal(sameRoleSequence(switched.members, nanoMatch.members), true);
    assert.equal(switched.members.every((row) => row.modelId.startsWith("or-")), true);
    assert.equal(COUNCIL_BLUEPRINT.oneProviderPerRun, true);
  });
});
