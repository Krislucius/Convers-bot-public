import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  UNKNOWN_SOURCE_COMMIT,
  isReleaseHealthy,
  productionSync,
  resolveSourceCommit,
  systemIdentity,
} from "./identity.ts";

describe("resolveSourceCommit", () => {
  it("falls back to UNKNOWN when env is missing or empty", () => {
    assert.equal(resolveSourceCommit(undefined), UNKNOWN_SOURCE_COMMIT);
    assert.equal(resolveSourceCommit({}), UNKNOWN_SOURCE_COMMIT);
    assert.equal(resolveSourceCommit({ VITE_SOURCE_COMMIT: "  " }), UNKNOWN_SOURCE_COMMIT);
  });

  it("rejects values that are not a git SHA", () => {
    assert.equal(resolveSourceCommit({ VITE_SOURCE_COMMIT: "main" }), UNKNOWN_SOURCE_COMMIT);
    assert.equal(resolveSourceCommit({ VITE_SOURCE_COMMIT: "not-a-sha" }), UNKNOWN_SOURCE_COMMIT);
    assert.equal(resolveSourceCommit({ VITE_SOURCE_COMMIT: "ggggggg" }), UNKNOWN_SOURCE_COMMIT);
  });

  it("accepts a 7–40 hex SHA and lowercases it", () => {
    assert.equal(resolveSourceCommit({ VITE_SOURCE_COMMIT: "58CB91A" }), "58cb91a");
    assert.equal(
      resolveSourceCommit({ VITE_SOURCE_COMMIT: "58cb91aee6f8efa5f0dd6d4a1921ced0a4ecd8a4" }),
      "58cb91aee6f8efa5f0dd6d4a1921ced0a4ecd8a4",
    );
  });

  it("prefers VITE_SOURCE_COMMIT over Vercel and SOURCE_COMMIT", () => {
    assert.equal(
      resolveSourceCommit({
        VITE_SOURCE_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        VERCEL_GIT_COMMIT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        SOURCE_COMMIT: "cccccccccccccccccccccccccccccccccccccccc",
      }),
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("uses VERCEL_GIT_COMMIT_SHA when VITE_SOURCE_COMMIT is absent", () => {
    assert.equal(
      resolveSourceCommit({ VERCEL_GIT_COMMIT_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }),
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });
});

describe("systemIdentity", () => {
  it("exposes sourceCommit without changing the rest of the identity", () => {
    const id = systemIdentity();
    assert.equal(typeof id.sourceCommit, "string");
    assert.ok(id.sourceCommit === UNKNOWN_SOURCE_COMMIT || /^[0-9a-f]{7,40}$/.test(id.sourceCommit));
    assert.equal(id.projectId, "01a048b8-c1f7-7382-9dfd-fb30bff7137d");
    assert.equal(id.buildId, "CB-BUILD-20260903-018");
    assert.equal(id.architectureRevision, "CB-ARCH-20260901-002");
  });

  it("treats SOURCE_COMMIT=UNKNOWN as diagnostic, not a health failure", () => {
    const id = systemIdentity();
    assert.equal(isReleaseHealthy({ ...id, sourceCommit: UNKNOWN_SOURCE_COMMIT } as typeof id), true);
    assert.equal(isReleaseHealthy({ buildId: id.buildId, architectureRevision: id.architectureRevision }), true);
    assert.equal(productionSync(UNKNOWN_SOURCE_COMMIT), false);
    assert.equal(productionSync("CB-BUILD-20260903-018"), true);
  });

  it("statically reads import.meta.env.VITE_SOURCE_COMMIT so Vite inlines it", () => {
    const src = readFileSync(fileURLToPath(new URL("./identity.ts", import.meta.url)), "utf8");
    assert.match(src, /import\.meta\.env\.VITE_SOURCE_COMMIT/);
    assert.equal(src.includes("as Record<string, string"), false);
  });
});
