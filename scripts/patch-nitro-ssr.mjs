#!/usr/bin/env node
/**
 * Nitro/Rolldown currently emits a broken Vercel SSR barrel:
 *   - `_ssr/ssr.mjs` re-exports `ssr_exports` without defining it
 *   - `_ssr/ssr2.mjs` imports `__exportAll` from that barrel (circular)
 * The result is HTTP 500 `{error:true,status:500,unhandled:true}` on every
 * SSR route. Production 001 was built before this split. Do not touch
 * Council/Evidence code here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function findSsrDir(root) {
  const candidates = [
    join(root, ".vercel", "output", "functions", "__server.func", "_ssr"),
    join(root, "functions", "__server.func", "_ssr"),
    root,
  ];
  return candidates.find((dir) => existsSync(join(dir, "ssr.mjs")));
}

export function patchSsrBarrel(source) {
  if (!source.includes("ssr_exports as s")) return { text: source, changed: false };
  if (/\bconst ssr_exports\s*=/.test(source)) return { text: source, changed: false };
  const next = source.replace(
    /export \{ getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t \};/,
    `${SSR_EXPORTS_STUB}export { getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t };`,
  );
  if (next === source) {
    throw new Error("ssr.mjs exports ssr_exports but the expected export line was not found");
  }
  return { text: next, changed: true };
}

export function patchSsr2Circular(source) {
  if (!source.includes('from "./ssr.mjs"')) return { text: source, changed: false };
  if (!source.includes("__exportAll$1")) return { text: source, changed: false };
  let next = source.replace(/import \{ c as __exportAll\$1 \} from "\.\/ssr\.mjs";\n/, "");
  if (next === source) {
    throw new Error("ssr2.mjs imports __exportAll from ssr.mjs but the import line was not found");
  }
  if (!next.includes("function __exportAll$1(")) {
    next = next.replace(
      /import \{ AsyncLocalStorage \} from "node:async_hooks";\n/,
      `import { AsyncLocalStorage } from "node:async_hooks";\n${EXPORT_ALL_HELPER}`,
    );
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
