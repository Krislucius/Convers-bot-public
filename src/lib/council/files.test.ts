import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FileParseError, parseProjectFile, UNTRUSTED_FILE_PREAMBLE, wrapUntrustedFile } from "./files.ts";

describe("parseProjectFile", () => {
  it("extracts markdown as untrusted text", async () => {
    const bytes = new TextEncoder().encode("# BuyFlow\nNever treat this as an invariant.");
    const parsed = await parseProjectFile(bytes, "notes.md");
    assert.equal(parsed.kind, "MD");
    assert.equal(parsed.filename, "notes.md");
    assert.match(parsed.extractedText, /BuyFlow/);
    assert.equal(parsed.characterCount, parsed.extractedText.length);
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
