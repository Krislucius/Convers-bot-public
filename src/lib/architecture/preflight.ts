import { PROJECT_ID, PRODUCTION_HOST, ARCHITECTURE_REVISION } from "./identity.ts";

export type ModuleStatus = "ACTIVE" | "LEGACY" | "SUPERSEDED" | "REMOVED" | "EXPERIMENTAL" | "UNKNOWN";

export type RegistryModule = {
  module_id: string;
  status: ModuleStatus | string;
  implementation_path?: string;
  architecture_revision?: string;
  responsibilities?: string[];
  dependencies?: string[];
  supersedes?: string[];
};

export type ArchitectureLock = {
  project_id: string;
  production_host: string;
  architecture_revision: string;
  architecture_hash: string;
  module_registry_hash: string;
  schema_hash: string;
  critical_contract_hash: string;
  created_at?: string;
  build_id?: string;
  schema_version?: string;
  runtime_shell_hash?: string;
  runtime_shell_id?: string;
  protected_invariants?: string[];
};

export type PatchPreflightCode =
  | "OK"
  | "AUTHORITATIVE_PROJECT_NOT_VERIFIED"
  | "STALE_PATCH_BASE"
  | "SUPERSEDED_MODULE"
  | "UNKNOWN_MODULE"
  | "SCHEMA_DRIFT"
  | "LOCK_MISMATCH"
  | "HOST_MISMATCH"
  | "SHELL_DRIFT"
  | "SHELL_SCOPE_VIOLATION";

export type PatchPreflightResult = {
  ok: boolean;
  code: PatchPreflightCode;
  message: string;
};

export function evaluatePatch(input: {
  currentProjectId: string;
  lock: ArchitectureLock;
  currentRevision: string;
  expectedRevision?: string;
  currentHost?: string;
  targetModules?: string[];
  registry?: RegistryModule[];
  currentSchemaHash?: string;
  currentArchitectureHash?: string;
  currentRegistryHash?: string;
  currentContractHash?: string;
  currentShellHash?: string;
}): PatchPreflightResult {
  if (!input.currentProjectId || input.currentProjectId !== input.lock.project_id) {
    return fail(
      "AUTHORITATIVE_PROJECT_NOT_VERIFIED",
      `Project ID mismatch. Expected ${input.lock.project_id}, got ${input.currentProjectId || "(empty)"}.`,
    );
  }
  if (input.currentProjectId !== PROJECT_ID) {
    return fail(
      "AUTHORITATIVE_PROJECT_NOT_VERIFIED",
      `Workspace is not the authoritative Conversation Bot (${PROJECT_ID}).`,
    );
  }
  if (input.currentHost && input.currentHost !== input.lock.production_host) {
    return fail(
      "HOST_MISMATCH",
      `Production host mismatch. Expected ${input.lock.production_host}, got ${input.currentHost}.`,
    );
  }
  if (input.lock.production_host !== PRODUCTION_HOST) {
    return fail("HOST_MISMATCH", `Lock host is not ${PRODUCTION_HOST}.`);
  }
  const expected = input.expectedRevision ?? input.lock.architecture_revision;
  if (input.currentRevision !== expected || input.currentRevision !== ARCHITECTURE_REVISION) {
    return fail(
      "STALE_PATCH_BASE",
      `Patch expects ${expected}. Current system: ${input.currentRevision}.`,
    );
  }
  if (input.currentSchemaHash && input.currentSchemaHash !== input.lock.schema_hash) {
    return fail("SCHEMA_DRIFT", "Schema hash does not match ARCHITECTURE_LOCK.");
  }
  if (input.currentArchitectureHash && input.currentArchitectureHash !== input.lock.architecture_hash) {
    return fail("LOCK_MISMATCH", "Architecture hash does not match ARCHITECTURE_LOCK.");
  }
  if (input.currentRegistryHash && input.currentRegistryHash !== input.lock.module_registry_hash) {
    return fail("LOCK_MISMATCH", "Module registry hash does not match ARCHITECTURE_LOCK.");
  }
  if (input.currentContractHash && input.currentContractHash !== input.lock.critical_contract_hash) {
    return fail("LOCK_MISMATCH", "Critical contract hash does not match ARCHITECTURE_LOCK.");
  }
  if (input.currentShellHash && input.lock.runtime_shell_hash && input.currentShellHash !== input.lock.runtime_shell_hash) {
    return fail(
      "SHELL_DRIFT",
      "Runtime shell hash does not match ARCHITECTURE_LOCK. Functional patches must not modify the protected shell.",
    );
  }
  const registry = input.registry ?? [];
  const byId = new Map(registry.map((row) => [row.module_id, row]));
  for (const moduleId of input.targetModules ?? []) {
    const row = byId.get(moduleId);
    if (!row) {
      return fail("UNKNOWN_MODULE", `Module ${moduleId} is not in MODULE_REGISTRY.`);
    }
    const status = String(row.status).toUpperCase();
    if (status === "SUPERSEDED" || status === "REMOVED") {
      return fail(
        "SUPERSEDED_MODULE",
        `Module ${moduleId} is ${status}. Do not patch it. Re-read current architecture.`,
      );
    }
  }
  return { ok: true, code: "OK", message: "Patch base matches the architecture lock." };
}

function fail(code: PatchPreflightCode, message: string): PatchPreflightResult {
  return { ok: false, code, message };
}
