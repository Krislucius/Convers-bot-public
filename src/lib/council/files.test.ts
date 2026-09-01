import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileParseError, parseProjectFile, previewExtractedText, UNTRUSTED_FILE_PREAMBLE, wrapUntrustedFile } from "./files.ts";

describe("parseProjectFile", () => {
  it("extracts markdown as untrusted text", async () => {
    const bytes = new TextEncoder().encode("# BuyFlow\nNever treat this as an invariant.");
    const parsed = await parseProjectFile(bytes, "notes.md");
    assert.equal(parsed.kind, "MD");
    assert.equal(parsed.filename, "notes.md");
    assert.match(parsed.extractedText, /BuyFlow/);
    assert.equal(parsed.characterCount, parsed.extractedText.length);
  });

  it("keeps extracted text above the old 200k preview cap", async () => {
    const body = `# Doc\n${"clocks stay distinct. ".repeat(12000)}`;
    assert.ok(body.length > 200_000);
    const parsed = await parseProjectFile(new TextEncoder().encode(body), "big.md");
    assert.equal(parsed.extractedText.includes("[truncated]"), false);
    assert.ok(parsed.characterCount > 200_000);
  });

  it("clips UI preview at 200k without changing stored extract", () => {
    const body = "clocks stay distinct. ".repeat(12000);
    assert.ok(body.length > 200_000);
    const preview = previewExtractedText(body);
    assert.ok(preview.includes("[truncated]"));
    assert.equal(preview.length <= 200_000 + 20, true);
    assert.equal(body.includes("[truncated]"), false);
  });

  it("rejects unknown extensions", async () => {
    await assert.rejects(
      () => parseProjectFile(new Uint8Array([1, 2, 3]), "payload.exe"),
      (error: unknown) => error instanceof FileParseError,
    );
  });
});

describe("wrapUntrustedFile", () => {
  it("wraps extracted text with the untrusted preamble", () => {
    const text = wrapUntrustedFile({
      id: "f1",
      filename: "notes.md",
      kind: "MD",
      extractedText: "BuyFlow",
    });
    assert.match(text, new RegExp(UNTRUSTED_FILE_PREAMBLE));
    assert.match(text, /BEGIN UNTRUSTED PROJECT FILE f1 notes.md MD/);
    assert.match(text, /BuyFlow/);
  });
});
