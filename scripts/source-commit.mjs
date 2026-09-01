/**
 * Resolve the git SHA baked into `VITE_SOURCE_COMMIT`.
 *
 * Grok Publish often runs `vite build` without this repo's env wrapper and
 * without a `git` binary. The Vite plugin still has to inline a SHA, so
 * resolution is: explicit env → `git rev-parse` → raw `.git` files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_COMMIT_RE = /^[0-9a-f]{7,40}$/i;
export const UNKNOWN_SOURCE_COMMIT = "UNKNOWN";

export function defaultRepoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function normalizeSourceCommit(raw) {
  const value = String(raw ?? "").trim();
  if (!SOURCE_COMMIT_RE.test(value)) return "";
  return value.toLowerCase();
}

function gitDir(root) {
  const git = join(root, ".git");
  if (!existsSync(git)) return "";
  try {
    if (statSync(git).isDirectory()) return git;
  } catch {
    return "";
  }
  try {
    const text = readFileSync(git, "utf8").trim();
    const match = text.match(/^gitdir:\s*(.+)$/i);
    if (!match) return "";
    const dir = match[1].trim();
    return isAbsolute(dir) ? dir : join(root, dir);
  } catch {
    return "";
  }
}

/** Read HEAD from `.git` without spawning git (Grok/Vercel often omit the binary). */
export function gitHeadFromFs(root) {
  const dir = gitDir(root);
  if (!dir) return "";
  let head = "";
  try {
    head = readFileSync(join(dir, "HEAD"), "utf8").trim();
  } catch {
    return "";
  }
  const direct = normalizeSourceCommit(head);
  if (direct) return direct;
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (!refMatch) return "";
  const ref = refMatch[1].trim();
  try {
    const fromRef = normalizeSourceCommit(readFileSync(join(dir, ref), "utf8"));
    if (fromRef) return fromRef;
  } catch {
    /* packed-refs below */
  }
  try {
    const packed = readFileSync(join(dir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === ref) {
        const sha = normalizeSourceCommit(parts[0]);
        if (sha) return sha;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function gitHead(root) {
  try {
    return normalizeSourceCommit(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return "";
  }
}

/**
 * Env wins, then git, then `.git` files. Empty string means UNKNOWN at identity.
 */
export function resolveViteSourceCommit(processEnv, root = defaultRepoRoot()) {
  const candidates = [
    processEnv?.VITE_SOURCE_COMMIT,
    processEnv?.VERCEL_GIT_COMMIT_SHA,
    processEnv?.SOURCE_COMMIT,
    gitHead(root),
    gitHeadFromFs(root),
  ];
  for (const raw of candidates) {
    const value = normalizeSourceCommit(raw);
    if (value) return value;
  }
  return "";
}

export function withSourceCommitEnv(env, root = defaultRepoRoot()) {
  const next = { ...env };
  const existing = normalizeSourceCommit(next.VITE_SOURCE_COMMIT);
  if (existing) {
    next.VITE_SOURCE_COMMIT = existing;
    return next;
  }
  const sha = resolveViteSourceCommit(next, root);
  if (sha) next.VITE_SOURCE_COMMIT = sha;
  return next;
}

/** Inlines `import.meta.env.VITE_SOURCE_COMMIT` even when Vite is started without the wrapper. */
export function sourceCommitPlugin() {
  return {
    name: "conversation-bot:source-commit",
    config(userConfig) {
      const root = userConfig?.root || defaultRepoRoot();
      const sha = resolveViteSourceCommit(process.env, root) || UNKNOWN_SOURCE_COMMIT;
      if (sha !== UNKNOWN_SOURCE_COMMIT) process.env.VITE_SOURCE_COMMIT = sha;
      return {
        define: {
          "import.meta.env.VITE_SOURCE_COMMIT": JSON.stringify(sha),
        },
      };
    },
  };
}
