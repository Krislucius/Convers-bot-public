/** Runtime identity of the authoritative Conversation Bot. Do not invent a second project. */

export const PROJECT_ID = "01a048b8-c1f7-7382-9dfd-fb30bff7137d";
export const PRODUCTION_HOST = "https://swift-lake-solar-cosmic.grok.me";
export const ARCHITECTURE_REVISION = "CB-ARCH-20260829-001";
export const BUILD_ID = "CB-BUILD-20260830-003";
export const BUILD_TIMESTAMP = "2026-08-30T05:10:00.000Z";
export const SCHEMA_VERSION = "0004_project_files";
export const SOURCE_ROOT = "src";
export const LOCK_PATH = "docs/ARCHITECTURE_LOCK.json";
export const REGISTRY_PATH = "docs/MODULE_REGISTRY.json";

export type SystemIdentity = {
  projectId: string;
  productionHost: string;
  architectureRevision: string;
  buildId: string;
  buildTimestamp: string;
  schemaVersion: string;
};

export function systemIdentity(): SystemIdentity {
  return {
    projectId: PROJECT_ID,
    productionHost: PRODUCTION_HOST,
    architectureRevision: ARCHITECTURE_REVISION,
    buildId: BUILD_ID,
    buildTimestamp: BUILD_TIMESTAMP,
    schemaVersion: SCHEMA_VERSION,
  };
}
