import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  credentialFingerprint,
  last4Of,
  parseCredentialBag,
  stampSelectedValidation,
  upsertCredentialMeta,
} from "./credential.ts";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  openSecret,
  sealSecret,
} from "./credential-crypto.ts";
import { mergeStoredApiKeys } from "./api-key.ts";

const SECRET = "test-wrapping-key-do-not-use-in-prod";
const NANO = "sk-nano-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NANO_NEXT = "sk-nano-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OPENROUTER = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789abcd";

describe("credential crypto", () => {
  it("round-trips a secret and never stores plaintext", () => {
    const sealed = encryptSecret(NANO, SECRET);
    assert.equal(isEncryptedSecret(sealed), true);
    assert.equal(sealed.includes(NANO), false);
    assert.equal(sealed.includes("sk-nano-aaaaaaaa"), false);
    assert.equal(decryptSecret(sealed, SECRET), NANO);
  });

  it("passes through empty and already-sealed values", () => {
    assert.equal(encryptSecret("", SECRET), "");
    assert.equal(decryptSecret("", SECRET), "");
    const sealed = sealSecret(NANO, SECRET);
    assert.equal(sealSecret(sealed, SECRET), sealed);
    assert.equal(openSecret(NANO, SECRET), NANO);
  });

  it("wrong wrapping key does not yield plaintext", () => {
    const sealed = encryptSecret(NANO, SECRET);
    assert.equal(decryptSecret(sealed, "other-secret"), "");
  });

  it("legacy plaintext remains readable until resealed", () => {
    assert.equal(isEncryptedSecret(NANO), false);
    assert.equal(openSecret(NANO, SECRET), NANO);
    const resealed = sealSecret(NANO, SECRET);
    assert.equal(isEncryptedSecret(resealed), true);
    assert.equal(openSecret(resealed, SECRET), NANO);
  });
});

describe("credential public metadata", () => {
  it("fingerprint and last4 never equal the secret", () => {
    const fp = credentialFingerprint(NANO);
    assert.equal(fp.length, 16);
    assert.equal(fp.includes("sk-nano"), false);
    assert.equal(last4Of(NANO), "aaaa");
  });

  it("upsert replaces only the active provider and clear drops it", () => {
    let bag = upsertCredentialMeta({}, "nanogpt", NANO, "t1", "NOT_TESTED", null);
    bag = upsertCredentialMeta(bag, "openrouter", OPENROUTER, "t1", "CONNECTED", "t1");
    assert.equal(bag.nanogpt?.last4, "aaaa");
    assert.equal(bag.openrouter?.lastValidation, "CONNECTED");
    bag = upsertCredentialMeta(bag, "nanogpt", "", "t2", "NOT_TESTED", null);
    assert.equal(bag.nanogpt, undefined);
    assert.equal(bag.openrouter?.last4, "abcd");
  });

  it("stamping validation does not invent a missing credential", () => {
    const bag = stampSelectedValidation({}, "nanogpt", true, "t1");
    assert.deepEqual(bag, {});
  });

  it("parse ignores unknown shapes", () => {
    assert.deepEqual(parseCredentialBag(null), {});
    assert.deepEqual(parseCredentialBag("nope"), {});
  });
});

describe("provider isolation through merge + seal", () => {
  it("sealing NanoGPT does not rewrite the OpenRouter slot", () => {
    const merged = mergeStoredApiKeys(
      { nanogptKey: NANO, openrouterKey: OPENROUTER, openrusrouterKey: "" },
      { provider: "nanogpt", apiKey: NANO_NEXT },
    );
    assert.equal(merged.nanogptKey, NANO_NEXT);
    assert.equal(merged.openrouterKey, OPENROUTER);
    const sealedNano = sealSecret(merged.nanogptKey, SECRET);
    const sealedOr = sealSecret(merged.openrouterKey, SECRET);
    assert.equal(openSecret(sealedNano, SECRET), NANO_NEXT);
    assert.equal(openSecret(sealedOr, SECRET), OPENROUTER);
    assert.notEqual(sealedNano, sealedOr);
  });
});
