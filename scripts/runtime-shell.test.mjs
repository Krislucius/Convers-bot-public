import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyPatch,
  clientBundleServerHits,
  isProductPath,
  isShellPath,
  readShellSpec,
  repoRoot,
  runtimeShellHash,
  shellServerImportHits,
  uniqueShellFiles,
  verifyRuntimeShell,
} from "./runtime-shell.mjs";

const root = repoRoot();
const spec = readShellSpec(root);
const files = uniqueShellFiles(spec);

describe("runtime shell inventory", () => {
  it("lists the protected routing, auth, and deploy files", () => {
    assert.equal(spec.id, "CB-SHELL-20260902-001");
    for (const required of [
      "src/router.tsx",
      "src/routes/__root.tsx",
      "src/lib/auth/session-bootstrap.ts",
      "src/lib/boot-watchdog.ts",
      "vite.config.ts",
      "startup.sh",
      "scripts/patch-nitro-ssr.mjs",
    ]) {
      assert.ok(files.includes(required), required);
    }
    assert.match(runtimeShellHash(root), /^[a-f0-9]{64}$/);
  });

  it("every listed shell file exists", () => {
    const result = verifyRuntimeShell(root, null);
    assert.equal(
      result.errors.some((row) => row.code === "SHELL_FILE_MISSING"),
      false,
      JSON.stringify(result.errors),
    );
  });
});

describe("shell vs product scope", () => {
  it("treats Council and Evidence paths as product", () => {
    assert.equal(isProductPath("src/lib/council/orchestrate.ts"), true);
    assert.equal(isProductPath("src/lib/evidence/pack.ts"), true);
    assert.equal(isProductPath("src/routes/t.$taskId.tsx"), true);
    assert.equal(isProductPath("src/routes/index.tsx"), true);
    assert.equal(isProductPath("src/router.tsx"), false);
  });

  it("fails a mixed product + shell patch", () => {
    const out = classifyPatch(
      ["src/lib/evidence/pack.ts", "src/routes/__root.tsx"],
      files,
    );
    assert.equal(out.ok, false);
    assert.equal(out.code, "SHELL_SCOPE_VIOLATION");
  });

  it("allows a product-only patch", () => {
    const out = classifyPatch(["src/lib/evidence/pack.ts", "src/lib/council/protocol.ts"], files);
    assert.equal(out.ok, true);
    assert.equal(out.code, "PRODUCT_SCOPED");
  });

  it("allows a shell-only patch", () => {
    const out = classifyPatch(["src/routes/__root.tsx", "src/lib/boot-watchdog.ts"], files);
    assert.equal(out.ok, true);
    assert.equal(out.code, "SHELL_SCOPED");
  });

  it("allows workflow-only docs and gate scripts", () => {
    const out = classifyPatch(["docs/SERVICE_STATUS.md", "scripts/runtime-shell.mjs"], files);
    assert.equal(out.ok, true);
    assert.equal(out.code, "WORKFLOW_SCOPED");
  });
});

describe("client .server import gate", () => {
  it("does not allow static .server imports in the live shell", () => {
    const hits = shellServerImportHits(root, spec);
    assert.deepEqual(
      hits.filter((row) => row.kind === "static"),
      [],
    );
  });

  it("flags a static .server import in a fake shell file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-shell-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "docs/RUNTIME_SHELL.json"),
      JSON.stringify({ id: "test", files: ["src/client.ts"] }),
    );
    writeFileSync(join(dir, "src/client.ts"), `import { x } from "./verify.server";\n`);
    const hits = shellServerImportHits(dir);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].kind, "static");
  });

  it("allows createServerFn dynamic .server imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-shell-fn-"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "docs/RUNTIME_SHELL.json"),
      JSON.stringify({ id: "test", files: ["src/root.ts"] }),
    );
    writeFileSync(
      join(dir, "src/root.ts"),
      `import { createServerFn } from "@tanstack/react-start";\nconst fn = createServerFn({ method: "POST" }).handler(async () => { await import("./verify.server"); });\n`,
    );
    assert.deepEqual(shellServerImportHits(dir), []);
  });

  it("detects .server leakage in a client bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-bundle-"));
    writeFileSync(join(dir, "index-abc.js"), `import "./verify.server.ts";\n`);
    const out = clientBundleServerHits(dir);
    assert.equal(out.ok, false);
    assert.equal(out.code, "CLIENT_SERVER_IMPORT");
  });

  it("passes a clean client bundle", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-bundle-ok-"));
    writeFileSync(join(dir, "index-abc.js"), `console.log("guest");\n`);
    const out = clientBundleServerHits(dir);
    assert.equal(out.ok, true);
  });
});

describe("isShellPath", () => {
  it("matches listed files only", () => {
    assert.equal(isShellPath("src/router.tsx", files), true);
    assert.equal(isShellPath("src/lib/council/orchestrate.ts", files), false);
  });
});
