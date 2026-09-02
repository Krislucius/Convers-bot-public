#!/usr/bin/env node
/**
 * Nitro/Rolldown currently emits a broken Vercel SSR barrel:
 *   - `_ssr/ssr.mjs` re-exports `ssr_exports` without defining it
 *   - `_ssr/ssr2.mjs` imports `__exportAll` from that barrel (circular)
 * The result is HTTP 500 `{error:true,status:500,unhandled:true}` on every
 * SSR route. Production 001 was built before this split. Do not touch
 * Council/Evidence code here.
 *
 * Runs from the nitro `compiled` hook (inside `vite build`) and again from
 * `npm run build` as a second pass. Both are idempotent.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SSR_DIR = join(here, "..", ".vercel", "output", "functions", "__server.func", "_ssr");

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

function walkForSsr(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return undefined;
  if (existsSync(join(dir, "ssr.mjs"))) return dir;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules") continue;
    const found = walkForSsr(join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
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
  return walkForSsr(root, 5);
}

export function patchSsrBarrel(source) {
  if (!source.includes("ssr_exports as s")) return { text: source, changed: false };
  if (/\bconst ssr_exports\s*=/.test(source)) return { text: source, changed: false };
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
  if (!existsSync(ssrPath) || !existsSync(ssr2Path)) {
    return { ok: false, error: `missing ssr barrels in ${dir}`, patched: [] };
  }
  const patched = [];
  const ssr = patchSsrBarrel(readFileSync(ssrPath, "utf8"));
  if (ssr.changed) {
    writeFileSync(ssrPath, ssr.text);
    patched.push("ssr.mjs");
  }
  const ssr2 = patchSsr2Circular(readFileSync(ssr2Path, "utf8"));
  if (ssr2.changed) {
    writeFileSync(ssr2Path, ssr2.text);
    patched.push("ssr2.mjs");
  }
  return { ok: true, dir, patched };
}

/** Nitro `compiled` hook: wait for barrels, then patch. Never throw after a successful write. */
export async function patchNitroCompiled(nitro) {
  const serverDir = nitro?.options?.output?.serverDir;
  const rootDir = nitro?.options?.rootDir;
  let last = { ok: false, error: "no ssr.mjs in nitro output", patched: [] };
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const dir = (serverDir && findSsrDir(serverDir)) || (rootDir && findSsrDir(rootDir));
    if (dir) {
      last = patchNitroSsr(dir);
      if (last.ok) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(here, "..");
  const dir = findSsrDir(root);
  if (!dir) {
    console.error("[patch-nitro-ssr] no ssr.mjs under .vercel/output — run npm run build first");
    process.exit(1);
  }
  const result = patchNitroSsr(dir);
  if (!result.ok) {
    console.error(`[patch-nitro-ssr] ${result.error}`);
    process.exit(1);
  }
  console.log(
    result.patched.length
      ? `[patch-nitro-ssr] patched ${result.patched.join(", ")} in ${dir}`
      : `[patch-nitro-ssr] already patched ${dir}`,
  );
}
