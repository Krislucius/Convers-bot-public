import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  findSsrDir,
  patchNitroCompiled,
  patchNitroSsr,
  patchSsrBarrel,
  patchSsr2Circular,
  stagePgliteAssets,
  writeVercelOutputConfig,
} from "./patch-nitro-ssr.mjs";

const BROKEN_SSR = `import { a as getRequest, c as server_exports, s as server_default } from "./ssr2.mjs";
export { getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t };
`;

const BROKEN_SSR2 = `import { c as __exportAll$1 } from "./ssr.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
var server_exports = /* @__PURE__ */ __exportAll$1({
	getRequest: () => getRequest
});
export { server_exports as c };
`;

describe("patch-nitro-ssr", () => {
  it("defines ssr_exports on the barrel so the module can load", () => {
    const out = patchSsrBarrel(BROKEN_SSR);
    assert.equal(out.changed, true);
    assert.match(out.text, /const ssr_exports = \{/);
    assert.match(out.text, /ssr_exports as s/);
    assert.equal(patchSsrBarrel(out.text).changed, false);
  });

  it("breaks the ssr2 circular import of __exportAll", () => {
    const out = patchSsr2Circular(BROKEN_SSR2);
    assert.equal(out.changed, true);
    assert.equal(out.text.includes('from "./ssr.mjs"'), false);
    assert.match(out.text, /function __exportAll\$1\(/);
    assert.equal(patchSsr2Circular(out.text).changed, false);
  });

  it("patches both files on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "nitro-ssr-"));
    writeFileSync(join(dir, "ssr.mjs"), BROKEN_SSR);
    writeFileSync(join(dir, "ssr2.mjs"), BROKEN_SSR2);
    const result = patchNitroSsr(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.patched.sort(), ["ssr.mjs", "ssr2.mjs"]);
    const ssr = readFileSync(join(dir, "ssr.mjs"), "utf8");
    const ssr2 = readFileSync(join(dir, "ssr2.mjs"), "utf8");
    assert.match(ssr, /const ssr_exports/);
    assert.equal(ssr2.includes('from "./ssr.mjs"'), false);
  });

  it("accepts a unified ssr.mjs that already defines ssr_exports without ssr2", () => {
    const dir = mkdtempSync(join(tmpdir(), "nitro-ssr-unified-"));
    const unified = `var ssr_exports = { default: () => server_default, t: () => server_exports };
export { getServerFnById as a, __exportAll as c, createServerEntry, server_default as default, TSS_SERVER_FUNCTION as i, createMiddleware as n, getRequest as o, createServerFn as r, ssr_exports as s, server_exports as t };
`;
    writeFileSync(join(dir, "ssr.mjs"), unified);
    const result = patchNitroSsr(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.patched, []);
    assert.equal(patchSsrBarrel(unified).changed, false);
  });

  it("injects ssr_exports even when the export list differs", () => {
    const src = `import { s as server_default, c as server_exports } from "./ssr2.mjs";
export { server_default as default, ssr_exports as s, server_exports as t };
`;
    const out = patchSsrBarrel(src);
    assert.equal(out.changed, true);
    assert.match(out.text, /const ssr_exports = \{/);
    assert.match(out.text, /ssr_exports as s/);
  });

  it("finds _ssr under a Vercel __server.func directory", () => {
    const root = mkdtempSync(join(tmpdir(), "nitro-ssr-find-"));
    const ssrDir = join(root, "_ssr");
    mkdirSync(ssrDir);
    writeFileSync(join(ssrDir, "ssr.mjs"), BROKEN_SSR);
    assert.equal(findSsrDir(root), ssrDir);
  });

  it("patches from the nitro compiled hook using output.serverDir", async () => {
    const root = mkdtempSync(join(tmpdir(), "nitro-ssr-compiled-"));
    const serverDir = join(root, "functions", "__server.func");
    const ssrDir = join(serverDir, "_ssr");
    mkdirSync(ssrDir, { recursive: true });
    writeFileSync(join(ssrDir, "ssr.mjs"), BROKEN_SSR);
    writeFileSync(join(ssrDir, "ssr2.mjs"), BROKEN_SSR2);
    const result = await patchNitroCompiled({
      options: { output: { serverDir }, rootDir: root },
    });
    assert.equal(result.ok, true);
    assert.ok(result.patched.some((row) => String(row).includes("ssr.mjs")));
  });

  it("copies pglite wasm/data assets next to the bundled driver", () => {
    const func = mkdtempSync(join(tmpdir(), "nitro-pglite-"));
    const libs = join(func, "_libs");
    mkdirSync(libs);
    writeFileSync(join(libs, "electric-sql__pglite.mjs"), "export {}\n");
    const result = stagePgliteAssets(func);
    assert.equal(result.ok, true);
    assert.ok(result.copied.includes("pglite.data"));
    assert.ok(result.copied.includes("pglite.wasm"));
    assert.ok(result.copied.includes("initdb.wasm"));
    assert.equal(existsSync(join(libs, "pglite.data")), true);
    assert.equal(existsSync(join(libs, "pglite.wasm")), true);
    assert.equal(existsSync(join(libs, "initdb.wasm")), true);
  });

  it("writes Vercel Build Output config.json and .vc-config.json", () => {
    const output = mkdtempSync(join(tmpdir(), "nitro-vercel-output-"));
    const func = join(output, "functions", "__server.func");
    mkdirSync(func, { recursive: true });
    writeFileSync(join(func, "index.mjs"), "export {}\n");
    const result = writeVercelOutputConfig(output);
    assert.equal(result.ok, true);
    assert.ok(result.written.includes("config.json"));
    assert.ok(result.written.includes(".vc-config.json"));
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8"));
    assert.equal(config.version, 3);
    assert.ok(config.routes.some((row) => row.handle === "filesystem"));
    assert.ok(config.routes.some((row) => row.dest === "/__server"));
    const vc = JSON.parse(readFileSync(join(func, ".vc-config.json"), "utf8"));
    assert.equal(vc.handler, "index.mjs");
    assert.equal(vc.launcherType, "Nodejs");
    assert.equal(writeVercelOutputConfig(output).written.length, 0);
  });
});
