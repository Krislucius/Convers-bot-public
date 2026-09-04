import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/** Sandbox-only. Survives Vite restarts so Better Auth sessions keep matching durable PGLite users. */
export const DEFAULT_PREVIEW_AUTH_SECRET_PATH = "/workspace/artifacts/grok-auth-preview-secret";

export type PreviewSecretEnv = {
  BETTER_AUTH_SECRET?: string;
  VERCEL?: string;
  NODE_ENV?: string;
  GROK_AUTH_PREVIEW_SECRET_PATH?: string;
};

export function previewAuthSecretPath(env: PreviewSecretEnv): string | null {
  if (env.BETTER_AUTH_SECRET?.trim()) return null;
  if (env.VERCEL === "1" || env.NODE_ENV === "production") return null;
  const explicit = env.GROK_AUTH_PREVIEW_SECRET_PATH?.trim();
  if (explicit === "memory" || explicit === "off" || explicit === "0") return null;
  if (explicit) return explicit;
  return DEFAULT_PREVIEW_AUTH_SECRET_PATH;
}

export function readPreviewAuthSecretFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const value = readFileSync(path, "utf8").trim();
    return /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function writePreviewAuthSecretFile(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
}

export function loadOrCreatePreviewAuthSecret(env: PreviewSecretEnv, existing?: string): string {
  const path = previewAuthSecretPath(env);
  if (existing) {
    if (path) {
      try {
        const disk = readPreviewAuthSecretFile(path);
        if (disk !== existing) writePreviewAuthSecretFile(path, existing);
      } catch {
        /* disk not writable — keep the in-memory secret */
      }
    }
    return existing;
  }
  if (path) {
    const disk = readPreviewAuthSecretFile(path);
    if (disk) return disk;
    const created = randomBytes(32).toString("hex");
    try {
      writePreviewAuthSecretFile(path, created);
    } catch {
      /* ignore */
    }
    return created;
  }
  return randomBytes(32).toString("hex");
}
