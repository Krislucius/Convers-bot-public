import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_SANDBOX_PGLITE_DIR,
  ensurePgliteDataDir,
  resolvePgliteDataDir,
} from "./db-pglite-path.ts";

describe("resolvePgliteDataDir", () => {
  it("skips a data dir when Neon is configured", () => {
    assert.equal(
      resolvePgliteDataDir({ DATABASE_URL: "postgres://neon/db", NODE_ENV: "development" }),
      undefined,
    );
  });

  it("treats whitespace DATABASE_URL as unset", () => {
    assert.equal(resolvePgliteDataDir({ DATABASE_URL: "   ", NODE_ENV: "development" }), DEFAULT_SANDBOX_PGLITE_DIR);
  });

  it("uses the sandbox artifacts dir in live preview", () => {
    assert.equal(resolvePgliteDataDir({ NODE_ENV: "development" }), DEFAULT_SANDBOX_PGLITE_DIR);
    assert.equal(resolvePgliteDataDir({}), DEFAULT_SANDBOX_PGLITE_DIR);
  });

  it("stays ephemeral on Vercel and production preview", () => {
    assert.equal(resolvePgliteDataDir({ NODE_ENV: "production" }), undefined);
    assert.equal(resolvePgliteDataDir({ VERCEL: "1", NODE_ENV: "development" }), undefined);
  });

  it("honors an explicit path and memory override", () => {
    assert.equal(resolvePgliteDataDir({ PGLITE_DATA_DIR: "/tmp/cb-pglite" }), "/tmp/cb-pglite");
    assert.equal(resolvePgliteDataDir({ PGLITE_DATA_DIR: "memory" }), undefined);
    assert.equal(resolvePgliteDataDir({ PGLITE_DATA_DIR: "off" }), undefined);
    assert.equal(resolvePgliteDataDir({ PGLITE_DATA_DIR: "0" }), undefined);
  });

  it("lets an explicit path win even in production", () => {
    assert.equal(
      resolvePgliteDataDir({ NODE_ENV: "production", PGLITE_DATA_DIR: "/tmp/forced" }),
      "/tmp/forced",
    );
  });
});

describe("ensurePgliteDataDir", () => {
  it("creates a writable directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-pglite-ensure-"));
    rmSync(dir, { recursive: true, force: true });
    const nested = join(dir, "cluster");
    try {
      assert.equal(ensurePgliteDataDir(nested), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
