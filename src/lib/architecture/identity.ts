/** Runtime identity of the authoritative Conversation Bot. Do not invent a second project. */

export const PROJECT_ID = "01a048b8-c1f7-7382-9dfd-fb30bff7137d";
export const PRODUCTION_HOST = "https://swift-lake-solar-cosmic.grok.me";
export const ARCHITECTURE_REVISION = "CB-ARCH-20260901-002";
export const BUILD_ID = "CB-BUILD-20260904-025";
export const BUILD_TIMESTAMP = "2026-09-04T11:40:00.000Z";
export const SCHEMA_VERSION = "0006_closed_loop";
export const SOURCE_ROOT = "src";
export const LOCK_PATH = "docs/ARCHITECTURE_LOCK.json";
export const REGISTRY_PATH = "docs/MODULE_REGISTRY.json";
export const UNKNOWN_SOURCE_COMMIT = "UNKNOWN";

const SOURCE_COMMIT_RE = /^[0-9a-f]{7,40}$/i;

export type SystemIdentity = {
  projectId: string;
  productionHost: string;
  architectureRevision: string;
  buildId: string;
  buildTimestamp: string;
  schemaVersion: string;
  sourceCommit: string;
};

/** Normalize a git SHA from build/runtime env. Anything else is UNKNOWN. */
export function resolveSourceCommit(env: Record<string, string | undefined> | undefined): string {
  if (!env) return UNKNOWN_SOURCE_COMMIT;
  const raw = env.VITE_SOURCE_COMMIT ?? env.VERCEL_GIT_COMMIT_SHA ?? env.SOURCE_COMMIT ?? "";
  const value = String(raw).trim();
  if (!SOURCE_COMMIT_RE.test(value)) return UNKNOWN_SOURCE_COMMIT;
  return value.toLowerCase();
}

/**
 * Vite only inlines a static `import.meta.env.VITE_*` member access.
 * Dynamic lookup of import.meta.env as a Record is undefined in the client bundle.
 */
function bakedEnv(): Record<string, string | undefined> {
  const viteCommit =
    typeof import.meta !== "undefined" &&
    import.meta.env != null &&
    typeof import.meta.env.VITE_SOURCE_COMMIT === "string"
      ? import.meta.env.VITE_SOURCE_COMMIT
      : undefined;
  const node = typeof process !== "undefined" && process.env ? process.env : {};
  return {
    VITE_SOURCE_COMMIT: viteCommit ?? node.VITE_SOURCE_COMMIT,
    VERCEL_GIT_COMMIT_SHA: node.VERCEL_GIT_COMMIT_SHA,
    SOURCE_COMMIT: node.SOURCE_COMMIT,
  };
}

export function sourceCommit(): string {
  return resolveSourceCommit(bakedEnv());
}

/** BUILD_ID is the deployed release. SOURCE_COMMIT is diagnostic and never required for health. */
export function isReleaseHealthy(id: Pick<SystemIdentity, "buildId" | "architectureRevision">): boolean {
  return id.buildId === BUILD_ID && id.architectureRevision === ARCHITECTURE_REVISION;
}

/** PROD_SYNC: production BUILD_ID matches this git release. SOURCE_COMMIT is ignored. */
export function productionSync(productionBuildId: string, expectedBuildId = BUILD_ID): boolean {
  return productionBuildId === expectedBuildId;
}

export function systemIdentity(): SystemIdentity {
  return {
    projectId: PROJECT_ID,
    productionHost: PRODUCTION_HOST,
    architectureRevision: ARCHITECTURE_REVISION,
    buildId: BUILD_ID,
    buildTimestamp: BUILD_TIMESTAMP,
    schemaVersion: SCHEMA_VERSION,
    sourceCommit: sourceCommit(),
  };
}
