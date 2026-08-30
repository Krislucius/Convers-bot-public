/** Shared Neon/pg pool settings for serverless. Two pools (auth + app SQL) must stay small. */

export const NEON_POOL_MAX = 2;
export const NEON_POOL_CONNECTION_TIMEOUT_MS = 5_000;
export const NEON_POOL_IDLE_TIMEOUT_MS = 8_000;
export const NEON_QUERY_TIMEOUT_MS = 8_000;

export function neonPoolConfig(connectionString: string) {
  return {
    connectionString,
    max: NEON_POOL_MAX,
    min: 0,
    connectionTimeoutMillis: NEON_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: NEON_POOL_IDLE_TIMEOUT_MS,
    allowExitOnIdle: true,
    // JS-side timer — safe with Neon pgbouncer (no session SET / startup options).
    query_timeout: NEON_QUERY_TIMEOUT_MS,
  };
}
