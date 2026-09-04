import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeKey, mergeStoredApiKeys, sanitizeApiKey } from "./api-key.ts";

const NANO = "sk-nano-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NANO_NEXT = "sk-nano-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("mergeStoredApiKeys", () => {
  const current = {
    openrouterKey: NANO,
    openrusrouterKey: "orr_live_bbbbbbbbbbbbbbbbbbbb",
  };

  it("keeps the saved API key when Save is pressed with an empty field", () => {
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
      apiKey: NANO_NEXT,
    });
    assert.equal(next.openrouterKey, NANO_NEXT);
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });

  it("clears only the active provider key", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter", clearKey: true });
    assert.equal(next.openrouterKey, "");
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });

  it("does not store an OpenRouter key in the NanoGPT slot", () => {
    const next = mergeStoredApiKeys(current, {
      provider: "openrouter",
      apiKey: "sk-or-v1-cccccccccccccccccccccccccccccccccccccccccccccccccc",
    });
    assert.equal(next.openrouterKey, current.openrouterKey);
  });
});

describe("sanitizeApiKey", () => {
  it("extracts a NanoGPT token from pasted env assignment", () => {
    const key = sanitizeApiKey(`NANOGPT_API_KEY=${NANO}`, "openrouter");
    assert.equal(key, NANO);
  });

  it("drops OpenRouter keys from the NanoGPT slot", () => {
    assert.equal(sanitizeApiKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", "openrouter"), "");
  });
});

describe("describeKey", () => {
  it("accepts a NanoGPT key", () => {
    const hint = describeKey(NANO, "openrouter");
    assert.equal(hint.ok, true);
    assert.match(hint.text, /NanoGPT/);
  });

  it("rejects an OpenRouter key on the API slot", () => {
    const hint = describeKey("sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", "openrouter");
    assert.equal(hint.ok, false);
    assert.match(hint.text, /OpenRouter/);
  });
});
