import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ARCHITECTURE_REVISION, PRODUCTION_HOST, PROJECT_ID } from "./identity.ts";
import { evaluatePatch, type ArchitectureLock, type RegistryModule } from "./preflight.ts";
import { resolveChatsForRun } from "../history/provenance.ts";
import type { ChatSource } from "../history/types.ts";
import { CONTEXT_TOKEN_LIMIT, boundContext } from "../council/protocol.ts";
import { CURRENT_CONTEXT_PACKER, CURRENT_CONTEXT_TOKEN_LIMIT } from "./contracts.ts";

const lock: ArchitectureLock = {
  project_id: PROJECT_ID,
  production_host: PRODUCTION_HOST,
  architecture_revision: ARCHITECTURE_REVISION,
  architecture_hash: "arch",
  module_registry_hash: "reg",
  schema_hash: "schema",
  critical_contract_hash: "contract",
};

const registry: RegistryModule[] = [
  { module_id: "council.orchestrator", status: "ACTIVE" },
  { module_id: "legacy.python-fastapi", status: "SUPERSEDED" },
  { module_id: "context.evidence-ledger", status: "ACTIVE" },
];

function sampleChat(projectId: string, id: string): ChatSource {
  return {
    id,
    projectId,
    provider: "GROK",
    title: id,
    sourceUrl: null,
    importMethod: "PASTE",
    accessStatus: "ACCESSIBLE",
    importStatus: "IMPORTED",
    rawContent: "body",
    messageCount: 1,
    characterCount: 4,
    estimatedTokenCount: 1,
    contentHash: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    importedAt: "2026-01-01T00:00:00.000Z",
    lastAccessCheckAt: null,
    lastError: null,
    includeInMemory: true,
  };
}

describe("architecture patch preflight", () => {
  it("accepts a patch against the current lock", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      expectedRevision: ARCHITECTURE_REVISION,
      currentHost: PRODUCTION_HOST,
      targetModules: ["council.orchestrator"],
      registry,
      currentSchemaHash: "schema",
      currentArchitectureHash: "arch",
      currentRegistryHash: "reg",
      currentContractHash: "contract",
    });
    assert.equal(out.ok, true);
    assert.equal(out.code, "OK");
  });

  it("refuses a wrong project id", () => {
    const out = evaluatePatch({
      currentProjectId: "other-project",
      lock,
      currentRevision: ARCHITECTURE_REVISION,
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "AUTHORITATIVE_PROJECT_NOT_VERIFIED");
  });

  it("refuses a stale architecture revision", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      expectedRevision: "CB-ARCH-20260904-004",
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "STALE_PATCH_BASE");
  });

  it("refuses targeting a superseded module", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      targetModules: ["legacy.python-fastapi"],
      registry,
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "SUPERSEDED_MODULE");
  });

  it("refuses an unknown module id", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      targetModules: ["old.context-builder.v0"],
      registry,
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "UNKNOWN_MODULE");
  });

  it("detects schema drift", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      currentSchemaHash: "tampered",
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "SCHEMA_DRIFT");
  });

  it("detects a wrong production host", () => {
    const out = evaluatePatch({
      currentProjectId: PROJECT_ID,
      lock,
      currentRevision: ARCHITECTURE_REVISION,
      currentHost: "https://example.invalid",
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "HOST_MISMATCH");
  });
});

describe("architecture stress: isolation and context packer", () => {
  it("keeps project A chats out of project B context", () => {
    const sources = [sampleChat("A", "a1"), sampleChat("B", "b1")];
    const fromA = resolveChatsForRun("B", ["a1", "b1"], sources);
    assert.equal(fromA.length, 1);
    assert.equal(fromA[0]?.id, "b1");
  });

  it("locks the evidence ledger packer and refuses silent first-N slice", () => {
    assert.equal(CURRENT_CONTEXT_PACKER, "evidenceLedgerPacker");
    assert.equal(CONTEXT_TOKEN_LIMIT, CURRENT_CONTEXT_TOKEN_LIMIT);
    assert.throws(() => boundContext("字".repeat(CURRENT_CONTEXT_TOKEN_LIMIT + 10)), /CONTEXT_BUDGET_EXCEEDED/);
    assert.equal(boundContext("ok"), "ok");
  });
});
