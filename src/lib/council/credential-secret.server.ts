/** Server-only wrapping key for provider credentials. Same lifetime as Better Auth signing. */

import { loadOrCreatePreviewAuthSecret } from "@/lib/auth/preview-secret";

export function credentialEncryptionSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const auth = env.BETTER_AUTH_SECRET?.trim();
  if (auth) return auth;
  return loadOrCreatePreviewAuthSecret(env);
}
