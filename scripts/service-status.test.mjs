import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { repoRoot } from "./arch-preflight.mjs";

const REQUIRED = [
  "FUNCTIONALITY",
  "STATUS:",
  "FUNCTION BLOCKERS:",
  "BUILD WORKFLOW",
  "WORKFLOW BLOCKERS:",
  "RELEASE",
  "LOCAL:",
  "REMOTE:",
  "PRODUCTION:",
  "SYNC:",
];

describe("service status tracks", () => {
  it("keeps functionality and workflow tracks separate", () => {
    const text = readFileSync(join(repoRoot(), "docs/SERVICE_STATUS.md"), "utf8");
    for (const row of REQUIRED) {
      assert.ok(text.includes(row), `missing ${row}`);
    }
    assert.match(text, /Build\/deploy failure alone is never a FUNCTION BLOCKER/);
    assert.match(text, /Product defect after successful implementation\/deploy is a FUNCTION BLOCKER/);
    assert.match(text, /\bREADY\b/);
    assert.match(text, /\bDEGRADED\b/);
    assert.match(text, /\bBLOCKED\b/);
    assert.match(text, /\bFAILED\b/);
    assert.equal(text.includes("Never mix them"), true);
    assert.match(text, /RUNTIME_SHELL/);
    assert.match(text, /shell:gate/);
    assert.match(text, /real browser smoke/);
  });
});
