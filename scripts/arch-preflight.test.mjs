import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ARCHITECTURE_REVISION,
  PROJECT_ID,
  currentFingerprints,
  repoRoot,
  verifyLock,
  writeLock,
} from "./arch-preflight.mjs";

const root = repoRoot();

describe("architecture lock (workspace)", () => {
  it("fingerprints are stable 64-char sha256", () => {
    const hashes = currentFingerprints(root);
    for (const value of Object.values(hashes)) {
      assert.match(value, /^[a-f0-9]{64}$/);
    }
  });

  it("workspace lock matches current source after write", () => {
    const lock = writeLock(root);
    const result = verifyLock(root, { expectRevision: ARCHITECTURE_REVISION });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(lock.project_id, PROJECT_ID);
    assert.equal(result.projectId, PROJECT_ID);
  });

  it("refuses a superseded python module target", () => {
    writeLock(root);
    const result = verifyLock(root, { targetModules: ["legacy.python-fastapi"] });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((row) => row.code === "SUPERSEDED_MODULE"), true);
  });

  it("refuses an unknown module", () => {
    writeLock(root);
    const result = verifyLock(root, { targetModules: ["old.context-builder.v0"] });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((row) => row.code === "UNKNOWN_MODULE"), true);
  });

  it("detects schema drift against a cloned lock", () => {
    writeLock(root);
    const clone = mkdtempSync(join(tmpdir(), "arch-lock-"));
    for (const rel of [
      ".project_id",
      "docs",
      "migrations",
      "src/lib/architecture",
      "src/lib/council/protocol.ts",
      "src/lib/council/task-mode.ts",
      "src/lib/council/orchestrate.ts",
      "conversation-bot/LEGACY.md",
    ]) {
      const from = join(root, rel);
      const to = join(clone, rel);
      mkdirSync(join(to, ".."), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    writeFileSync(join(clone, "migrations", "0099_drift.sql"), "-- drift\n");
    const result = verifyLock(clone);
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((row) => row.code === "SCHEMA_DRIFT"), true);
  });
});
