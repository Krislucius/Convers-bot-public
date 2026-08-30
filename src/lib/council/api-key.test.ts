import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeStoredApiKeys, sanitizeApiKey } from "./api-key.ts";

describe("mergeStoredApiKeys", () => {
  const current = {
    openrouterKey: "sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    openrusrouterKey: "orr_live_bbbbbbbbbbbbbbbbbbbb",
  };

  it("keeps the saved OpenRouter key when Save is pressed with an empty field", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter", apiKey: "" });
    assert.equal(next.openrouterKey, current.openrouterKey);
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });

  it("keeps the saved key when apiKey is omitted (model-only save)", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter" });
    assert.equal(next.openrouterKey, current.openrouterKey);
  });

  it("replaces only the active provider key", () => {
    const next = mergeStoredApiKeys(current, {
      provider: "openrouter",
      apiKey: "sk-or-v1-cccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    assert.equal(next.openrouterKey, "sk-or-v1-cccccccccccccccccccccccccccccccccccccccccccccccccc");
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });

  it("clears only the active provider key", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter", clearKey: true });
    assert.equal(next.openrouterKey, "");
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });
});

describe("sanitizeApiKey", () => {
  it("extracts an OpenRouter token from pasted env assignment", () => {
    const key = sanitizeApiKey("OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", "openrouter");
    assert.equal(key, "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789");
  });
});
