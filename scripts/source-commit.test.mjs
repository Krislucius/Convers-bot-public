import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  gitHeadFromFs,
  resolveViteSourceCommit,
  sourceCommitPlugin,
  withSourceCommitEnv,
} from "./source-commit.mjs";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function fakeGit(headText, refs = {}, packed = "") {
  const root = mkdtempSync(join(tmpdir(), "src-commit-"));
  const git = join(root, ".git");
  mkdirSync(join(git, "refs", "heads"), { recursive: true });
  writeFileSync(join(git, "HEAD"), headText);
  for (const [name, sha] of Object.entries(refs)) {
    writeFileSync(join(git, name), `${sha}\n`);
  }
  if (packed) writeFileSync(join(git, "packed-refs"), packed);
  return root;
}

test("gitHeadFromFs reads a detached HEAD", () => {
  const root = fakeGit(`${SHA}\n`);
  assert.equal(gitHeadFromFs(root), SHA);
});

test("gitHeadFromFs follows ref: refs/heads/main", () => {
  const root = fakeGit("ref: refs/heads/main\n", { "refs/heads/main": SHA2 });
  assert.equal(gitHeadFromFs(root), SHA2);
});

test("gitHeadFromFs reads packed-refs when the loose ref is missing", () => {
  const packed = `# pack-refs\n${SHA} refs/heads/main\n`;
  const root = fakeGit("ref: refs/heads/main\n", {}, packed);
  assert.equal(gitHeadFromFs(root), SHA);
});

test("gitHeadFromFs returns empty without .git", () => {
  const root = mkdtempSync(join(tmpdir(), "src-commit-nogit-"));
  assert.equal(gitHeadFromFs(root), "");
});

test("resolveViteSourceCommit prefers env over filesystem git", () => {
  const root = fakeGit(`${SHA}\n`);
  assert.equal(
    resolveViteSourceCommit({ VITE_SOURCE_COMMIT: SHA2 }, root),
    SHA2,
  );
});

test("resolveViteSourceCommit falls back to .git when git/env are empty", () => {
  const root = fakeGit(`${SHA}\n`);
  const sha = resolveViteSourceCommit({ PATH: "/usr/bin" }, root);
  assert.equal(sha, SHA);
});

test("withSourceCommitEnv fills VITE_SOURCE_COMMIT from .git", () => {
  const root = fakeGit(`${SHA}\n`);
  const env = withSourceCommitEnv({ PATH: "/usr/bin" }, root);
  assert.equal(env.VITE_SOURCE_COMMIT, SHA);
});

test("sourceCommitPlugin defines import.meta.env.VITE_SOURCE_COMMIT", () => {
  const root = fakeGit(`${SHA}\n`);
  const prev = process.env.VITE_SOURCE_COMMIT;
  const prevVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  const prevSource = process.env.SOURCE_COMMIT;
  delete process.env.VITE_SOURCE_COMMIT;
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.SOURCE_COMMIT;
  try {
    const plugin = sourceCommitPlugin();
    const out = plugin.config({ root });
    assert.equal(out.define["import.meta.env.VITE_SOURCE_COMMIT"], JSON.stringify(SHA));
  } finally {
    if (prev !== undefined) process.env.VITE_SOURCE_COMMIT = prev;
    else delete process.env.VITE_SOURCE_COMMIT;
    if (prevVercel !== undefined) process.env.VERCEL_GIT_COMMIT_SHA = prevVercel;
    if (prevSource !== undefined) process.env.SOURCE_COMMIT = prevSource;
  }
});
