#!/usr/bin/env node
/**
 * End-to-end runtime shell gate.
 *
 *   node scripts/shell-gate.mjs           # hash, scope, .server imports
 *   node scripts/shell-gate.mjs --full    # plus production build and built-browser smoke
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientBundleServerHits,
  defaultClientBundleDir,
  repoRoot,
  verifyRuntimeShell,
} from "./runtime-shell.mjs";

const root = repoRoot();
const full = process.argv.includes("--full");

function fail(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}

function run(cmd, args) {
  const out = spawnSync(cmd, args, { cwd: root, encoding: "utf8", env: process.env });
  if (out.status !== 0) {
    fail({
      ok: false,
      code: "SHELL_GATE_COMMAND",
      command: [cmd, ...args].join(" "),
      status: out.status,
      stderr: (out.stderr || "").slice(-4000),
      stdout: (out.stdout || "").slice(-4000),
    });
  }
  return out;
}

const lockPath = join(root, "docs/ARCHITECTURE_LOCK.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
const shell = verifyRuntimeShell(root, lock);
if (!shell.ok) fail({ ok: false, stage: "runtime-shell", ...shell });

const gates = {
  runtime_shell: { ok: true, id: shell.id, hash: shell.hash, scope: shell.scope.code },
  client_server_imports: { ok: shell.importHits.length === 0, hits: shell.importHits },
};

if (full) {
  run("npm", ["run", "build"]);
  const bundle = clientBundleServerHits(defaultClientBundleDir(root));
  gates.production_build = { ok: true };
  gates.client_bundle = bundle;
  if (!bundle.ok) fail({ ok: false, stage: "client-bundle", ...bundle, gates });
  run("npm", ["run", "preview:restart"]);
  run("node", ["scripts/client-boot-smoke.mjs", "http://127.0.0.1:8081/"]);
  run("node", ["scripts/browser-smoke.mjs", "http://127.0.0.1:8081/", "/workspace/artifacts/shell-gate.png"]);
  gates.built_browser_smoke = { ok: true, url: "http://127.0.0.1:8081/" };
}

const result = { ok: true, full, gates };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(0);
