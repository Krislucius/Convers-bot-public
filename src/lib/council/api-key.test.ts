import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeKey, mergeStoredApiKeys, sanitizeApiKey, storedKeyFor } from "./api-key.ts";

const NANO = "sk-nano-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NANO_NEXT = "sk-nano-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcd";
const OPENRUS = "orr_live_bbbbbbbbbbbbbbbbbbbb";

describe("mergeStoredApiKeys", () => {
  const current = {
    nanogptKey: NANO,
    openrouterKey: OPENROUTER,
    openrusrouterKey: OPENRUS,
  };

  it("keeps the saved API key when Save is pressed with an empty field", () => {
    const next = mergeStoredApiKeys(current, { provider: "nanogpt", apiKey: "" });
    assert.equal(next.nanogptKey, current.nanogptKey);
    assert.equal(next.openrouterKey, current.openrouterKey);
  });

  it("keeps the saved key when apiKey is omitted (model-only save)", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter" });
    assert.equal(next.openrouterKey, current.openrouterKey);
    assert.equal(next.nanogptKey, current.nanogptKey);
  });

  it("replaces only the active provider key", () => {
    const next = mergeStoredApiKeys(current, { provider: "nanogpt", apiKey: NANO_NEXT });
    assert.equal(next.nanogptKey, NANO_NEXT);
    assert.equal(next.openrouterKey, current.openrouterKey);
    assert.equal(next.openrusrouterKey, current.openrusrouterKey);
  });

  it("clears only the active provider key", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter", clearKey: true });
    assert.equal(next.openrouterKey, "");
    assert.equal(next.nanogptKey, current.nanogptKey);
  });

  it("does not store an OpenRouter key in the NanoGPT slot", () => {
    const next = mergeStoredApiKeys(current, { provider: "nanogpt", apiKey: OPENROUTER });
    assert.equal(next.nanogptKey, current.nanogptKey);
    assert.equal(next.openrouterKey, current.openrouterKey);
  });

  it("does not store a NanoGPT key in the OpenRouter slot", () => {
    const next = mergeStoredApiKeys(current, { provider: "openrouter", apiKey: NANO_NEXT });
    assert.equal(next.openrouterKey, current.openrouterKey);
    assert.equal(next.nanogptKey, current.nanogptKey);
  });
});

describe("sanitizeApiKey", () => {
  it("extracts a NanoGPT token from pasted env assignment", () => {
    assert.equal(sanitizeApiKey(`NANOGPT_API_KEY=${NANO}`, "nanogpt"), NANO);
  });

  it("drops OpenRouter keys from the NanoGPT slot", () => {
    assert.equal(sanitizeApiKey(OPENROUTER, "nanogpt"), "");
  });

  it("drops NanoGPT keys from the OpenRouter slot", () => {
    assert.equal(sanitizeApiKey(NANO, "openrouter"), "");
  });

  it("extracts an OpenRouter token on the OpenRouter slot", () => {
    assert.equal(sanitizeApiKey(OPENROUTER, "openrouter"), OPENROUTER);
  });
});

describe("describeKey", () => {
  it("accepts a NanoGPT key", () => {
    const hint = describeKey(NANO, "nanogpt");
    assert.equal(hint.ok, true);
    assert.match(hint.text, /NanoGPT/);
  });

  it("accepts an OpenRouter key", () => {
    const hint = describeKey(OPENROUTER, "openrouter");
    assert.equal(hint.ok, true);
    assert.match(hint.text, /OpenRouter/);
  });

  it("rejects an OpenRouter key on the NanoGPT slot", () => {
    const hint = describeKey(OPENROUTER, "nanogpt");
    assert.equal(hint.ok, false);
    assert.match(hint.text, /OpenRouter/);
  });

  it("rejects a NanoGPT key on the OpenRouter slot", () => {
    const hint = describeKey(NANO, "openrouter");
    assert.equal(hint.ok, false);
    assert.match(hint.text, /NanoGPT/);
  });
});

describe("credential isolation", () => {
  it("resolves only the selected provider secret", () => {
    const keys = {
      nanogptKey: NANO,
      openrouterKey: OPENROUTER,
      openrusrouterKey: OPENRUS,
    };
    assert.equal(storedKeyFor(keys, "nanogpt"), NANO);
    assert.equal(storedKeyFor(keys, "openrouter"), OPENROUTER);
    assert.equal(storedKeyFor(keys, "openrusrouter"), OPENRUS);
  });
});
