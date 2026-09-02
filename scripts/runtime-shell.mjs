#!/usr/bin/env node
/**
 * Protected runtime shell: hash, product-vs-shell scope, and client/.server import gates.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = "docs/RUNTIME_SHELL.json";

export function repoRoot(from = here) {
  return join(from, "..");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function readShellSpec(root) {
  return JSON.parse(readFileSync(join(root, SPEC_PATH), "utf8"));
}

export function uniqueShellFiles(spec) {
  return [...new Set(spec.files ?? [])].sort();
}

const PRODUCT_PREFIXES = [
  "src/lib/council/",
  "src/lib/evidence/",
  "src/lib/history/",
  "src/components/council",
  "src/routes/p.",
  "src/routes/t.",
  "migrations/",
];

const PRODUCT_FILES = new Set(["src/routes/index.tsx", "src/routes/settings.tsx"]);

export function isProductPath(rel) {
  const path = String(rel ?? "").replaceAll("\\", "/");
  if (PRODUCT_FILES.has(path)) return true;
  return PRODUCT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isShellPath(rel, shellFiles) {
  return shellFiles.includes(String(rel ?? "").replaceAll("\\", "/"));
}

export function classifyPatch(changedRelPaths, shellFiles) {
  const changed = [...new Set((changedRelPaths ?? []).map((row) => String(row).replaceAll("\\", "/")))].filter(
    Boolean,
  );
  const shellChanged = changed.filter((path) => isShellPath(path, shellFiles));
  const productChanged = changed.filter((path) => isProductPath(path) && !isShellPath(path, shellFiles));
  if (shellChanged.length > 0 && productChanged.length > 0) {
    return {
      ok: false,
      code: "SHELL_SCOPE_VIOLATION",
      message:
        "Functional product files and the protected runtime shell changed in the same patch. Split the shell change out.",
      shellChanged,
      productChanged,
    };
  }
  return {
    ok: true,
    code: shellChanged.length ? "SHELL_SCOPED" : productChanged.length ? "PRODUCT_SCOPED" : "WORKFLOW_SCOPED",
    message: "Patch stays on one side of the runtime shell boundary.",
    shellChanged,
    productChanged,
  };
}

export function shellFileHashes(root, spec = readShellSpec(root)) {
  const files = {};
  for (const rel of uniqueShellFiles(spec)) {
    const abs = join(root, rel);
    if (!existsSync(abs)) {
      throw new Error(`Runtime shell file missing: ${rel}`);
    }
    files[rel] = sha256(readFileSync(abs, "utf8"));
  }
  return files;
}

export function runtimeShellHash(root, spec = readShellSpec(root)) {
  const files = {};
  for (const rel of uniqueShellFiles(spec)) {
    const abs = join(root, rel);
    files[rel] = existsSync(abs) ? sha256(readFileSync(abs, "utf8")) : "MISSING";
  }
  return sha256(JSON.stringify({ id: spec.id, files }));
}

export function shellServerImportHits(root, spec = readShellSpec(root)) {
  const hits = [];
  for (const rel of uniqueShellFiles(spec)) {
    if (!/\.(ts|tsx|mjs|js)$/.test(rel)) continue;
    if (/\.server\.(ts|tsx|js|mjs)$/.test(rel)) continue;
    const source = readFileSync(join(root, rel), "utf8");
    const staticFrom = /from\s+["']([^"']+\.server(?:\.[a-z]+)?)["']/g;
    let match;
    while ((match = staticFrom.exec(source))) {
      hits.push({ file: rel, spec: match[1], kind: "static" });
    }
    const dynamicImport = /import\s*\(\s*["']([^"']+\.server(?:\.[a-z]+)?)["']\s*\)/g;
    const allowsDynamic = source.includes("createServerFn");
    while ((match = dynamicImport.exec(source))) {
      if (allowsDynamic) continue;
      hits.push({ file: rel, spec: match[1], kind: "dynamic" });
    }
  }
  return hits;
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkFiles(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

export function clientBundleServerHits(clientDir) {
  if (!existsSync(clientDir)) {
    return {
      ok: false,
      code: "CLIENT_BUNDLE_MISSING",
      hits: [],
      message: `Client bundle directory missing: ${clientDir}`,
    };
  }
  const hits = [];
  for (const abs of walkFiles(clientDir)) {
    if (!abs.endsWith(".js")) continue;
    const text = readFileSync(abs, "utf8");
    if (text.includes(".server.ts") || text.includes("verify.server")) {
      hits.push(relative(clientDir, abs).replaceAll("\\", "/"));
    }
  }
  return {
    ok: hits.length === 0,
    code: hits.length ? "CLIENT_SERVER_IMPORT" : "OK",
    hits,
    message:
      hits.length === 0
        ? "Client bundle does not contain .server modules."
        : `Client bundle leaked .server modules: ${hits.slice(0, 8).join(", ")}`,
  };
}

export function gitChangedFiles(root) {
  const opts = { cwd: root, encoding: "utf8" };
  const names = new Set();
  try {
    for (const line of execFileSync("git", ["diff", "--name-only", "HEAD"], opts).split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
    for (const line of execFileSync("git", ["diff", "--cached", "--name-only"], opts).split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
    for (const line of execFileSync("git", ["ls-files", "--others", "--exclude-standard"], opts).split("\n")) {
      if (line.trim()) names.add(line.trim());
    }
  } catch {
    return [];
  }
  return [...names];
}

export function classifyGitPatch(root, spec = readShellSpec(root)) {
  return classifyPatch(gitChangedFiles(root), uniqueShellFiles(spec));
}

export function verifyRuntimeShell(root, lock = null) {
  const spec = readShellSpec(root);
  const files = uniqueShellFiles(spec);
  const missing = files.filter((rel) => !existsSync(join(root, rel)));
  const errors = [];
  if (missing.length) {
    errors.push({ code: "SHELL_FILE_MISSING", message: `Missing shell files: ${missing.join(", ")}` });
  }
  let hash = "";
  if (!missing.length) hash = runtimeShellHash(root, spec);
  if (lock?.runtime_shell_hash && hash && hash !== lock.runtime_shell_hash) {
    errors.push({
      code: "SHELL_DRIFT",
      message:
        "Runtime shell hash does not match ARCHITECTURE_LOCK. Functional patches must not modify the protected shell.",
    });
  }
  if (lock?.runtime_shell_id && spec.id !== lock.runtime_shell_id) {
    errors.push({
      code: "SHELL_DRIFT",
      message: `Runtime shell id mismatch. Lock ${lock.runtime_shell_id}, spec ${spec.id}.`,
    });
  }
  const importHits = missing.length ? [] : shellServerImportHits(root, spec);
  if (importHits.length) {
    errors.push({
      code: "CLIENT_SERVER_IMPORT",
      message: `Protected shell imports .server modules: ${importHits.map((h) => `${h.file} ${h.spec}`).join("; ")}`,
    });
  }
  const scope = classifyGitPatch(root, spec);
  if (!scope.ok) {
    errors.push({
      code: scope.code,
      message: scope.message,
      shellChanged: scope.shellChanged,
      productChanged: scope.productChanged,
    });
  }
  return {
    ok: errors.length === 0,
    hash,
    id: spec.id,
    files,
    importHits,
    scope,
    errors,
  };
}

export function defaultClientBundleDir(root) {
  return join(root, ".vercel/output/static/assets");
}

export function isMainModule(url = import.meta.url) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const root = repoRoot();
  const lockPath = join(root, "docs/ARCHITECTURE_LOCK.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
  const result = verifyRuntimeShell(root, lock);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.ok ? 0 : 1);
}
