#!/usr/bin/env node
/**
 * Nitro/Rolldown currently emits a broken Vercel SSR barrel:
 *   - `_ssr/ssr.mjs` re-exports `ssr_exports` without defining it
 *   - `_ssr/ssr2.mjs` imports `__exportAll` from that barrel (circular)
 * The result is HTTP 500 `{error:true,status:500,unhandled:true}` on every
 * SSR route. Production 001 was built before this split. Do not touch
 * Council/Evidence code here.
 *
 * Also copies PGLite wasm/data/initdb.wasm next to the bundled driver and
 * writes Vercel Build Output config.json / .vc-config.json (the user compiled
 * hook replaces Nitro's generateFunctionFiles).
 *
 * Runs from the nitro `compiled` and `close` hooks (inside `vite build`)
 * and again from `npm run build`. All passes are idempotent.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SSR_DIR = join(here, "..", ".vercel", "output", "functions", "__server.func", "_ssr");
export const DEFAULT_FUNC_DIR = join(here, "..", ".vercel", "output", "functions", "__server.func");
export const DEFAULT_OUTPUT_DIR = join(here, "..", ".vercel", "output");
const PGLITE_DIST = join(here, "..", "node_modules", "@electric-sql", "pglite", "dist");

const SSR_EXPORTS_STUB = `const ssr_exports = {
	get default() {
		return server_default;
	},
	get t() {
		return server_exports;
	},
};
`;

const EXPORT_ALL_HELPER = `var __defProp$exportAll = Object.defineProperty;
function __exportAll$1(all, no_symbols) {
	let target = {};
	for (var name in all) __defProp$exportAll(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp$exportAll(target, Symbol.toStringTag, { value: "Module" });
	return target;
}
`;

function walkForSsr(dir, depth, found) {
  if (depth < 0 || !existsSync(dir)) return found;
  if (existsSync(join(dir, "ssr.mjs"))) found.push(dir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules") continue;
    walkForSsr(join(dir, entry.name), depth - 1, found);
  }
  return found;
}

export function findSsrDir(root) {
  if (!root) return undefined;
  const candidates = [
    join(root, "_ssr"),
    join(root, ".vercel", "output", "functions", "__server.func", "_ssr"),
    join(root, "functions", "__server.func", "_ssr"),
    join(root, "__server.func", "_ssr"),
    root,
  ];
  const hit = candidates.find((dir) => existsSync(join(dir, "ssr.mjs")));
  if (hit) return hit;
  return walkForSsr(root, 5, [])[0];
}

export function findAllSsrDirs(root) {
  if (!root) return [];
  const seen = new Set();
  const out = [];
  const add = (dir) => {
    if (!dir || seen.has(dir) || !existsSync(join(dir, "ssr.mjs"))) return;
    seen.add(dir);
    out.push(dir);
  };
  add(findSsrDir(root));
  for (const dir of walkForSsr(root, 6, [])) add(dir);
  return out;
}

export function patchSsrBarrel(source) {
  if (!source.includes("ssr_exports as s")) return { text: source, changed: false };
  if (/\b(?:const|var|let) ssr_exports\s*=/.test(source)) return { text: source, changed: false };
  const exact = source.replace(
    /export \{ getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t \};/,
    `${SSR_EXPORTS_STUB}export { getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t };`,
  );
  if (exact !== source) return { text: exact, changed: true };
  const generic = source.replace(/export \{[^}]*ssr_exports as s[^}]*\};/, (block) => `${SSR_EXPORTS_STUB}${block}`);
  if (generic !== source) return { text: generic, changed: true };
  const injectAt = source.lastIndexOf("export {");
  if (injectAt < 0) {
    throw new Error("ssr.mjs exports ssr_exports but no export block was found");
  }
  return { text: source.slice(0, injectAt) + SSR_EXPORTS_STUB + source.slice(injectAt), changed: true };
}

export function patchSsr2Circular(source) {
  if (!source.includes('from "./ssr.mjs"')) return { text: source, changed: false };
  if (!source.includes("__exportAll$1")) return { text: source, changed: false };
  let next = source.replace(/import \{ c as __exportAll\$1 \} from "\.\/ssr\.mjs";\n?/, "");
  if (next === source) {
    next = source.replace(/import \{[^}]*__exportAll\$1[^}]*\} from "\.\/ssr\.mjs";\n?/, "");
  }
  if (next === source) {
    throw new Error("ssr2.mjs imports __exportAll from ssr.mjs but the import line was not found");
  }
  if (!next.includes("function __exportAll$1(")) {
    const als = /import \{ AsyncLocalStorage \} from "node:async_hooks";\n/;
    if (als.test(next)) {
      next = next.replace(als, `import { AsyncLocalStorage } from "node:async_hooks";\n${EXPORT_ALL_HELPER}`);
    } else {
      next = EXPORT_ALL_HELPER + next;
    }
    if (!next.includes("function __exportAll$1(")) {
      throw new Error("ssr2.mjs could not receive an inlined __exportAll helper");
    }
  }
  return { text: next, changed: true };
}

export function patchNitroSsr(ssrDir) {
  const dir = ssrDir ?? DEFAULT_SSR_DIR;
  const ssrPath = join(dir, "ssr.mjs");
  const ssr2Path = join(dir, "ssr2.mjs");
  if (!existsSync(ssrPath)) {
    return { ok: false, error: `missing ssr barrels in ${dir}`, patched: [] };
  }
  const ssrSource = readFileSync(ssrPath, "utf8");
  const unified = /\b(?:const|var|let) ssr_exports\s*=/.test(ssrSource);
  if (!existsSync(ssr2Path) && !unified) {
    return { ok: false, error: `missing ssr barrels in ${dir}`, patched: [] };
  }
  const patched = [];
  const ssr = patchSsrBarrel(ssrSource);
  if (ssr.changed) {
    writeFileSync(ssrPath, ssr.text);
    patched.push("ssr.mjs");
  }
  if (existsSync(ssr2Path)) {
    const ssr2 = patchSsr2Circular(readFileSync(ssr2Path, "utf8"));
    if (ssr2.changed) {
      writeFileSync(ssr2Path, ssr2.text);
      patched.push("ssr2.mjs");
    }
  }
  return { ok: true, dir, patched };
}

export function stagePgliteAssets(funcDir) {
  const dir = funcDir ?? DEFAULT_FUNC_DIR;
  const libs = join(dir, "_libs");
  const copied = [];
  if (!existsSync(join(libs, "electric-sql__pglite.mjs"))) return { ok: true, dir, copied };
  // The bundled driver resolves these via `new URL("./<name>", import.meta.url)`.
  // Missing initdb.wasm still kills the isolate with uncaught ENOENT after
  // pglite.data/pglite.wasm are present.
  for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
    const src = join(PGLITE_DIST, name);
    const dest = join(libs, name);
    if (!existsSync(src)) continue;
    if (existsSync(dest)) continue;
    copyFileSync(src, dest);
    copied.push(name);
  }
  return { ok: true, dir, copied };
}

const VC_CONFIG = {
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
};

/**
 * Grok preview iframes grok.me from grok.com. frame-ancestors overrides
 * X-Frame-Options in Chrome. CORP cross-origin lets the parent fetch the
 * HTML document. Missing hashed assets MUST 404 instead of falling through
 * to SSR (HTML as a module script → react:0 / script: index-….js, and the
 * continue:true immutable cache-control would cache that HTML for a year).
 */
export const FRAME_ANCESTORS =
  "frame-ancestors 'self' https://grok.com https://*.grok.com https://*.grok.me";

export const VERCEL_ROUTES = {
  version: 3,
  routes: [
    {
      src: "/(.*)",
      headers: {
        "content-security-policy": FRAME_ANCESTORS,
        "cross-origin-resource-policy": "cross-origin",
      },
      continue: true,
    },
    {
      src: "/assets/(.*)",
      headers: { "cache-control": "public,max-age=31536000,immutable" },
      continue: true,
    },
    { handle: "filesystem" },
    {
      src: "/assets/(.*)",
      status: 404,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    },
    { src: "/(.*)", dest: "/__server" },
  ],
};

function srcMatches(src, path) {
  try {
    return new RegExp(`^${src}$`).test(path);
  } catch {
    return false;
  }
}

/**
 * Walk Vercel Build Output routes the way the edge does: continue:true merges
 * headers and keeps going; filesystem serves a hit; later matches dest/status.
 */
export function resolveVercelRoute(path, { hasFile = false } = {}, routes = VERCEL_ROUTES.routes) {
  const headers = {};
  for (const row of routes) {
    if (row.handle === "filesystem") {
      if (hasFile) return { kind: "filesystem", status: 200, dest: "filesystem", headers: { ...headers } };
      continue;
    }
    if (!row.src || !srcMatches(row.src, path)) continue;
    if (row.headers) Object.assign(headers, row.headers);
    if (row.continue) continue;
    if (row.status) {
      return { kind: "status", status: row.status, dest: row.dest ?? null, headers: { ...headers } };
    }
    if (row.dest) {
      return { kind: "dest", status: 200, dest: row.dest, headers: { ...headers } };
    }
  }
  return { kind: "none", status: 404, dest: null, headers: { ...headers } };
}

export function vercelConfigMatches(parsed) {
  if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.routes)) return false;
  return JSON.stringify(parsed.routes) === JSON.stringify(VERCEL_ROUTES.routes);
}

/**
 * The nitro({ hooks.compiled }) in vite.config replaces the vercel preset's
 * compiled hook, so generateFunctionFiles never writes config.json /
 * .vc-config.json. Without them a prebuilt deploy cannot replace the live
 * function and production stays on the broken 003 isolate.
 *
 * Always rewrite config.json when routes drift — Nitro may write a stale
 * catch-all-only table first, and a skip-if-exists left 016 serving HTML for
 * missing /assets/*.
 */
export function writeVercelOutputConfig(outputDir) {
  const dir = outputDir ?? DEFAULT_OUTPUT_DIR;
  const funcDir = join(dir, "functions", "__server.func");
  const written = [];
  if (!existsSync(join(funcDir, "index.mjs"))) {
    return { ok: false, error: `missing __server.func/index.mjs in ${dir}`, written };
  }
  const vcPath = join(funcDir, ".vc-config.json");
  if (!existsSync(vcPath)) {
    writeFileSync(vcPath, `${JSON.stringify(VC_CONFIG, null, 2)}\n`);
    written.push(".vc-config.json");
  }
  const configPath = join(dir, "config.json");
  let needConfig = true;
  if (existsSync(configPath)) {
    try {
      needConfig = !vercelConfigMatches(JSON.parse(readFileSync(configPath, "utf8")));
    } catch {
      needConfig = true;
    }
  }
  if (needConfig) {
    writeFileSync(configPath, `${JSON.stringify(VERCEL_ROUTES, null, 2)}\n`);
    written.push("config.json");
  }
  return { ok: true, dir, written };
}


function funcDirFromSsr(ssrDir) {
  if (!ssrDir) return undefined;
  if (ssrDir.endsWith("_ssr")) return dirname(ssrDir);
  return ssrDir;
}

/** Nitro `compiled`/`close` hook: wait for barrels, patch every copy, stage PGLite assets. */
export async function patchNitroCompiled(nitro) {
  const serverDir = nitro?.options?.output?.serverDir;
  const rootDir = nitro?.options?.rootDir ?? join(here, "..");
  let last = { ok: false, error: "no ssr.mjs in nitro output", patched: [] };
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const dirs = [
      ...findAllSsrDirs(serverDir),
      ...findAllSsrDirs(rootDir),
      ...findAllSsrDirs(join(here, "..")),
    ];
    const unique = [...new Set(dirs)];
    if (unique.length) {
      const patched = [];
      for (const dir of unique) {
        last = patchNitroSsr(dir);
        if (last.ok) patched.push(...(last.patched ?? []).map((name) => `${dir}/${name}`));
        const staged = stagePgliteAssets(funcDirFromSsr(dir));
        if (staged.copied.length) patched.push(...staged.copied);
      }
      const vercel = writeVercelOutputConfig(join(here, "..", ".vercel", "output"));
      if (vercel.written?.length) patched.push(...vercel.written);
      if (last.ok) {
        last = { ...last, patched, dirs: unique };
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

export const patchNitroClose = patchNitroCompiled;

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(here, "..");
  const dirs = findAllSsrDirs(root);
  if (!dirs.length) {
    console.error("[patch-nitro-ssr] no ssr.mjs under .vercel/output — run npm run build first");
    process.exit(1);
  }
  let failed = false;
  for (const dir of dirs) {
    const result = patchNitroSsr(dir);
    if (!result.ok) {
      console.error(`[patch-nitro-ssr] ${result.error}`);
      failed = true;
      continue;
    }
    const staged = stagePgliteAssets(funcDirFromSsr(dir));
    console.log(
      result.patched.length
        ? `[patch-nitro-ssr] patched ${result.patched.join(", ")} in ${dir}`
        : `[patch-nitro-ssr] already patched ${dir}`,
    );
    if (staged.copied.length) {
      console.log(`[patch-nitro-ssr] staged ${staged.copied.join(", ")} in ${staged.dir}`);
    }
  }
  const vercel = writeVercelOutputConfig(join(root, ".vercel", "output"));
  if (vercel.ok && vercel.written.length) {
    console.log(`[patch-nitro-ssr] wrote ${vercel.written.join(", ")}`);
  } else if (!vercel.ok) {
    console.error(`[patch-nitro-ssr] ${vercel.error}`);
    failed = true;
  }
  if (failed) process.exit(1);
}
