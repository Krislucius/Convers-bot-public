import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectFile } from "../council/types.ts";
import {
  INDEXER_VERSION,
  classifyModules,
  formatRepoCitation,
  indexSelectedRepositories,
  parseRepoCitation,
  snapshotFromTree,
} from "./repo-index.ts";

function file(partial: Partial<ProjectFile> & Pick<ProjectFile, "id" | "filename">): ProjectFile {
  return {
    projectId: "p1",
    kind: "ZIP",
    extractedText: "",
    members: [],
    sourceTree: [],
    notes: "",
    sizeBytes: 1,
    characterCount: 1,
    estimatedTokens: 1,
    includeInMemory: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

const payments = { moduleId: "payments.gateway", implementationPath: "src/lib/payments.ts" };

describe("repository citations", () => {
  it("round-trips [REPO:path:symbol:lines@hash]", () => {
    const text = formatRepoCitation({
      path: "src/lib/payments.ts",
      symbol: "charge",
      startLine: 12,
      endLine: 14,
      hash: "abc123def456",
    });
    assert.equal(text, "[REPO:src/lib/payments.ts:charge:12-14@abc123def456]");
    const parsed = parseRepoCitation(text);
    assert.equal(parsed?.path, "src/lib/payments.ts");
    assert.equal(parsed?.symbol, "charge");
    assert.equal(parsed?.startLine, 12);
    assert.equal(parsed?.endLine, 14);
    assert.equal(parsed?.hash, "abc123def456");
  });
});

describe("classifyModules", () => {
  it("UNKNOWN when no repository is selected", () => {
    const rows = classifyModules({ modules: [payments], snapshot: null });
    assert.equal(rows[0]?.status, "UNKNOWN");
  });

  it("DESIGNED_ONLY when architecture/chat mentions a module absent from source", () => {
    const snapshot = snapshotFromTree({
      fileId: "f1",
      filename: "repo.zip",
      members: ["README.md"],
      sourceTree: [
        {
          path: "README.md",
          text: "The payments.gateway module will live at src/lib/payments.ts once implemented.",
        },
      ],
    });
    const rows = classifyModules({
      modules: [payments],
      snapshot,
      designMentions: ["payments.gateway is the canonical charge path"],
    });
    assert.equal(rows[0]?.status, "DESIGNED_ONLY");
  });

  it("docs that mention a module without source code are not IMPLEMENTED", () => {
    const snapshot = snapshotFromTree({
      fileId: "f1",
      filename: "repo.zip",
      members: ["docs/architecture.md"],
      sourceTree: [{ path: "docs/architecture.md", text: "Module payments.gateway: src/lib/payments.ts" }],
    });
    const rows = classifyModules({ modules: [payments], snapshot });
    assert.notEqual(rows[0]?.status, "VERIFIED_IMPLEMENTED");
    assert.notEqual(rows[0]?.status, "IMPLEMENTED_UNVERIFIED");
    assert.equal(rows[0]?.status, "DESIGNED_ONLY");
  });

  it("VERIFIED_IMPLEMENTED when source and tests exist", () => {
    const snapshot = snapshotFromTree({
      fileId: "f1",
      filename: "repo.zip",
      members: ["src/lib/payments.ts", "src/lib/payments.test.ts"],
      sourceTree: [
        { path: "src/lib/payments.ts", text: "export function charge() { return 1; }\n" },
        { path: "src/lib/payments.test.ts", text: "import { charge } from './payments.ts';\nassert.equal(charge(), 1);\n" },
      ],
    });
    const rows = classifyModules({ modules: [payments], snapshot });
    assert.equal(rows[0]?.status, "VERIFIED_IMPLEMENTED");
    assert.match(rows[0]?.citations[0] ?? "", /^\[REPO:src\/lib\/payments\.ts:/);
  });

  it("IMPLEMENTED_UNVERIFIED when code exists without tests", () => {
    const snapshot = snapshotFromTree({
      fileId: "f1",
      filename: "repo.zip",
      members: ["src/lib/payments.ts"],
      sourceTree: [{ path: "src/lib/payments.ts", text: "export function charge() { return 1; }\n" }],
    });
    const rows = classifyModules({ modules: [payments], snapshot });
    assert.equal(rows[0]?.status, "IMPLEMENTED_UNVERIFIED");
  });

  it("PARTIAL when the path is present without recoverable source text", () => {
    const snapshot = snapshotFromTree({
      fileId: "f1",
      filename: "repo.zip",
      members: ["src/lib/payments.ts"],
      sourceTree: [{ path: "src/lib/payments.ts", text: "" }],
    });
    const rows = classifyModules({ modules: [payments], snapshot });
    assert.equal(rows[0]?.status, "PARTIAL");
  });
});

describe("indexSelectedRepositories", () => {
  it("marks missing repository as UNKNOWN and recommends ADD_REPOSITORY_EVIDENCE", () => {
    const report = indexSelectedRepositories({ files: [], modules: [payments] });
    assert.equal(report.missingRepository, true);
    assert.equal(report.rows[0]?.status, "UNKNOWN");
    assert.equal(report.indexerVersion, INDEXER_VERSION);
    assert.ok(report.recommendations.some((row) => /source zip/i.test(row)));
  });

  it("returns REPOSITORY_SOURCE_CONFLICT for two different snapshots", () => {
    const a = file({
      id: "a",
      filename: "app-a.zip",
      sourceTree: [{ path: "src/lib/payments.ts", text: "export function charge() { return 1; }\n", bytes: 40 }],
    });
    const b = file({
      id: "b",
      filename: "app-b.zip",
      sourceTree: [{ path: "src/lib/payments.ts", text: "export function charge() { return 2; }\n", bytes: 40 }],
    });
    const report = indexSelectedRepositories({ files: [a, b], modules: [payments] });
    assert.equal(report.conflict, "REPOSITORY_SOURCE_CONFLICT");
    assert.equal(report.rows.every((row) => row.status === "UNKNOWN"), true);
    assert.ok(report.required.some((row) => /authoritative/i.test(row)));
  });

  it("does not treat design mentions as implementation proof", () => {
    const report = indexSelectedRepositories({
      files: [
        file({
          id: "docs",
          filename: "notes.md",
          kind: "MD",
          members: [],
          sourceTree: [],
          extractedText: "payments.gateway is fully implemented in production.",
        }),
      ],
      modules: [payments],
      designMentions: ["payments.gateway is fully implemented"],
    });
    assert.equal(report.missingRepository, true);
    assert.equal(report.rows[0]?.status, "UNKNOWN");
  });

  it("attaches implementation claims separately from design evidence", () => {
    const report = indexSelectedRepositories({
      files: [
        file({
          id: "zip",
          filename: "src.zip",
          sourceTree: [
            { path: "src/lib/payments.ts", text: "export function charge() { return 1; }\n", bytes: 40 },
            { path: "src/lib/payments.test.ts", text: "import { charge } from './payments.ts';\n", bytes: 40 },
          ],
        }),
      ],
      modules: [payments],
    });
    assert.equal(report.rows[0]?.status, "VERIFIED_IMPLEMENTED");
    assert.equal(report.claims[0]?.evidenceClass, "IMPLEMENTATION_EVIDENCE");
    assert.match(report.claims[0]?.citation ?? "", /^\[REPO:/);
  });
});
