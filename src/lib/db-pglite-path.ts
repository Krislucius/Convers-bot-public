import { accessSync, constants, mkdirSync } from "node:fs";

/** Durable sandbox cluster. Survives Vite restarts and execution; not committed. */
export const DEFAULT_SANDBOX_PGLITE_DIR = "/workspace/artifacts/pglite";

export type PgliteDirEnv = {
  DATABASE_URL?: string;
  PGLITE_DATA_DIR?: string;
  NODE_ENV?: string;
  VERCEL?: string;
};

function readEnv(): PgliteDirEnv {
  if (typeof process === "undefined" || !process.env) return {};
  return process.env;
}

/**
 * Where the PGLite fallback should persist when Neon is not configured.
 *
 * - `PGLITE_DATA_DIR=memory` (or `off` / `0`) → ephemeral, in-RAM
 * - any other `PGLITE_DATA_DIR` → that filesystem path
 * - Vercel / `NODE_ENV=production` → ephemeral (no writable durable disk)
 * - sandbox live preview → `/workspace/artifacts/pglite`
 *
 * Returns `undefined` when the caller should construct `new PGlite()` in memory.
 * Neon (`DATABASE_URL`) never uses this path.
 */
export function resolvePgliteDataDir(env: PgliteDirEnv = readEnv()): string | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) return undefined;

  const explicit = env.PGLITE_DATA_DIR?.trim();
  if (explicit === "memory" || explicit === "off" || explicit === "0") return undefined;
  if (explicit) return explicit;

  if (env.VERCEL === "1" || env.NODE_ENV === "production") return undefined;

  return DEFAULT_SANDBOX_PGLITE_DIR;
}

/** Create the directory if needed. False when the path is not writable. */
export function ensurePgliteDataDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
