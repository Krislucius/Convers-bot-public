import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  loadOrCreatePreviewAuthSecret,
  previewAuthSecretPath,
  readPreviewAuthSecretFile,
} from "./preview-secret.ts";

describe("previewAuthSecretPath", () => {
  it("is absent when a real BETTER_AUTH_SECRET or production is set", () => {
    assert.equal(previewAuthSecretPath({ BETTER_AUTH_SECRET: "deployed" }), null);
    assert.equal(previewAuthSecretPath({ NODE_ENV: "production" }), null);
    assert.equal(previewAuthSecretPath({ VERCEL: "1" }), null);
    assert.equal(previewAuthSecretPath({ GROK_AUTH_PREVIEW_SECRET_PATH: "memory" }), null);
  });

  it("uses the sandbox artifacts path in live preview", () => {
    assert.equal(previewAuthSecretPath({ NODE_ENV: "development" }), "/workspace/artifacts/grok-auth-preview-secret");
    assert.equal(previewAuthSecretPath({ GROK_AUTH_PREVIEW_SECRET_PATH: "/tmp/cb-secret" }), "/tmp/cb-secret");
  });
});

describe("loadOrCreatePreviewAuthSecret", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-preview-secret-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reuses a durable file across process-like calls", () => {
    const path = join(dir, "secret");
    const first = loadOrCreatePreviewAuthSecret({ GROK_AUTH_PREVIEW_SECRET_PATH: path });
    assert.match(first, /^[0-9a-f]{64}$/);
    const second = loadOrCreatePreviewAuthSecret({ GROK_AUTH_PREVIEW_SECRET_PATH: path });
    assert.equal(second, first);
    assert.equal(readPreviewAuthSecretFile(path), first);
  });

  it("writes an existing in-memory secret so a restart keeps sessions", () => {
    const path = join(dir, "from-memory");
    const existing = "a".repeat(64);
    const out = loadOrCreatePreviewAuthSecret({ GROK_AUTH_PREVIEW_SECRET_PATH: path }, existing);
    assert.equal(out, existing);
    assert.equal(readFileSync(path, "utf8").trim(), existing);
  });

  it("rejects a truncated file and mints a new secret", () => {
    const path = join(dir, "bad");
    writeFileSync(path, "nope\n");
    const minted = loadOrCreatePreviewAuthSecret({ GROK_AUTH_PREVIEW_SECRET_PATH: path });
    assert.match(minted, /^[0-9a-f]{64}$/);
    assert.equal(readPreviewAuthSecretFile(path), minted);
  });
});
