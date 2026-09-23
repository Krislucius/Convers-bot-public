import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractPdfText } from "../council/files.ts";
import { assertCommonEvidenceParity, buildCommonEvidencePacket, evidenceParity } from "./common-packet.ts";
import { classifyFileSource, scrubSourceContradictions } from "./source-state.ts";

const task = { title: "Договор", canonicalTaskEn: "Review the contract.", prompt: "Review the contract." };

function file(overrides: Partial<Parameters<typeof classifyFileSource>[0]> = {}) {
  return {
    id: "file-1",
    filename: "contract.pdf",
    kind: "PDF" as const,
    extractedText: "Привет. Это извлечённый текст договора, достаточный для Совета и проверки кириллицы.",
    notes: "PDF text extracted in memory only.",
    characterCount: 80,
    ...overrides,
  };
}

describe("common evidence parity", () => {
  it("extracts UTF-16 PDF text and marks the file EXTRACTED in Russian", () => {
    const text = extractPdfText(new TextEncoder().encode("<FEFF041F04400438043204350442> Tj"));
    assert.equal(text, "Привет");
    const state = classifyFileSource(file({ extractedText: `${text}. Договор поставки медицинского оборудования на русском языке.` }));
    assert.equal(state.sourceStatus, "EXTRACTED");
    assert.equal(state.language, "ru");
    assert.equal(state.extractionMethod, "pdf-text-v1");
  });

  it("gives every member the same snapshot and the same source availability", () => {
    const packet = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\nclaim one",
      chatCount: 1,
      files: [file()],
      chunkCountByFile: { "file-1": 4 },
      coverageStatus: "COMPLETE",
      packedCitations: ["file:file-1"],
    });
    const again = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\nclaim one",
      chatCount: 1,
      files: [file()],
      chunkCountByFile: { "file-1": 4 },
      coverageStatus: "COMPLETE",
      packedCitations: ["file:file-1"],
    });
    const views = [packet.memberContext, packet.memberContext, packet.memberContext];
    assert.equal(evidenceParity(views), "PASS");
    assert.equal(assertCommonEvidenceParity([packet, again, packet]), "PASS");
    assert.equal(packet.evidenceSnapshotId, again.evidenceSnapshotId);
    assert.equal(packet.packedEvidenceHash, again.packedEvidenceHash);
    assert.equal(packet.memberContext.includes("SOURCE_STATUS=EXTRACTED"), true);
    assert.equal(packet.memberContext.includes(packet.evidenceSnapshotId), true);
    assert.equal("LEDGER\nclaim one".includes("SOURCE AVAILABILITY"), false);
    assert.equal(packet.memberContext.startsWith("LEDGER\nclaim one"), true);
  });

  it("rejects a member view that differs from the common snapshot", () => {
    assert.equal(evidenceParity(["same", "same", "different"]), "FAIL");
  });

  it("propagates FAILED and PARTIAL identically and does not let a model deny an extracted file", () => {
    const failed = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\nnone",
      chatCount: 0,
      files: [file({ id: "bad", extractedText: "", notes: "extract failed", characterCount: 0 })],
      coverageStatus: "FAILED",
      packedCitations: [],
    });
    assert.equal(failed.sourceStates[0]?.sourceStatus, "FAILED");
    assert.equal(evidenceParity([failed.memberContext, failed.memberContext]), "PASS");
    assert.equal(failed.memberContext.includes("SOURCE_STATUS=FAILED"), true);

    const partial = classifyFileSource(file({ extractedText: "short", characterCount: 5 }));
    assert.equal(partial.sourceStatus, "PARTIAL");

    const extracted = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\ntext",
      chatCount: 1,
      files: [file()],
      coverageStatus: "COMPLETE",
      packedCitations: [],
    });
    const scrubbed = scrubSourceContradictions(
      "The PDF is unreadable and PDF text unavailable.\n\nThe contract price is fixed.",
      extracted.sourceStates,
    );
    assert.equal(scrubbed.contradicted, true);
    assert.equal(scrubbed.text.includes("unreadable"), false);
    assert.equal(scrubbed.text.includes("MODEL_SOURCE_STATE_CONTRADICTION"), true);
    assert.equal(scrubbed.text.includes("contract price is fixed"), true);
  });

  it("keeps provider out of the snapshot identity", () => {
    const left = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\nsame",
      chatCount: 1,
      files: [file()],
      coverageStatus: "COMPLETE",
      packedCitations: ["c1"],
    });
    const right = buildCommonEvidencePacket({
      task,
      packText: "LEDGER\nsame",
      chatCount: 1,
      files: [file()],
      coverageStatus: "COMPLETE",
      packedCitations: ["c1"],
    });
    assert.equal(left.evidenceSnapshotId, right.evidenceSnapshotId);
    assert.equal(JSON.stringify(left).includes("nanogpt"), false);
  });
});
