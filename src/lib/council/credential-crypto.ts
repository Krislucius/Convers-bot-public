/** AES-256-GCM at-rest encryption for provider API secrets. Ciphertext only — never log plaintext. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const CREDENTIAL_ENC_PREFIX = "enc:v1:";

export function isEncryptedSecret(value: string): boolean {
  return value.trim().startsWith(CREDENTIAL_ENC_PREFIX);
}

function keyMaterial(secret: string): Buffer {
  return createHash("sha256").update(`cb-provider-creds:v1:${secret}`, "utf8").digest();
}

export function encryptSecret(plaintext: string, secret: string): string {
  const value = plaintext.trim();
  if (!value) return "";
  if (isEncryptedSecret(value)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyMaterial(secret), iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CREDENTIAL_ENC_PREFIX}${iv.toString("base64url")}:${enc.toString("base64url")}:${tag.toString("base64url")}`;
}

export function decryptSecret(stored: string, secret: string): string {
  const value = stored.trim();
  if (!value) return "";
  if (!isEncryptedSecret(value)) return value;
  const body = value.slice(CREDENTIAL_ENC_PREFIX.length);
  const parts = body.split(":");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyMaterial(secret), Buffer.from(parts[0], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[1], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export function sealSecret(value: string, secret: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (isEncryptedSecret(trimmed)) return trimmed;
  return encryptSecret(trimmed, secret);
}

export function openSecret(stored: string, secret: string): string {
  return decryptSecret(stored, secret);
}
