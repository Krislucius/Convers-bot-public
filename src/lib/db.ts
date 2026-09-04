import { pendingMigrations } from "../../scripts/migration-plan.mjs";
import { neonPoolConfig } from "./db-pool";
import { ensurePgliteDataDir, resolvePgliteDataDir, shouldReopenPglite } from "./db-pglite-path";

/** Which database backend is active. */
export type DbSource = "neon" | "pglite";

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — otherwise production would silently run on the PGLite fallback.
const rawDatabaseUrl =
  typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl =
  rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/**
 * Active backend: real **Neon** when `DATABASE_URL` is set (deployed / configured
 * sandbox), otherwise a local embedded **PGLite** (Postgres compiled to WASM) so
 * the app has a working database even with nothing configured — the live preview
 * included. Swap in Neon later by just setting `DATABASE_URL`; no code changes.
 */
export const dbSource: DbSource = databaseUrl ? "neon" : "pglite";

/**
 * Filesystem path for the PGLite cluster when the sandbox is not on Neon.
 * `undefined` means in-memory (production preview / Vercel without DATABASE_URL).
 */
export const pgliteDataDir: string | undefined =
  dbSource === "pglite" ? resolvePgliteDataDir() : undefined;

/**
 * Minimal shared SQL surface, satisfied by both Neon and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
}

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
  __pgliteDataDir__?: string | undefined;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
function toSql(run: Run): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  return sql;
}

function createNeonSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Regular Postgres driver: node-postgres (`pg`) — works directly with Neon's
    // pooled endpoint. One pool per process; warm serverless instances reuse it.
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    if (!databaseUrl) throw new Error("DATABASE_URL missing on Neon path");
    const pool = new Pool(neonPoolConfig(databaseUrl));
    return toSql(async <T>(text: string, params: unknown[]) => {
      const res = await pool.query(text, params);
      return res.rows as T[];
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

function pgliteParsers() {
  return {
    [OID_INT8]: Number,
    [OID_DATE]: identity,
    [OID_INTERVAL]: identity,
  };
}

function clearPgliteSlot(): void {
  globalRef.__pgliteInstance__ = undefined;
  globalRef.__pgSqlPromise__ = undefined;
  globalRef.__pgliteMigrateChain__ = undefined;
}

function registerPgliteShutdown(): void {
  const g = globalThis as typeof globalThis & { __pgliteShutdown__?: boolean };
  if (g.__pgliteShutdown__) return;
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  g.__pgliteShutdown__ = true;
  const flush = () => {
    const inst = globalRef.__pgliteInstance__;
    clearPgliteSlot();
    if (!inst) return;
    void inst
      .then((pg) => {
        if (!pg.closed) return pg.close();
        return undefined;
      })
      .catch(() => undefined);
  };
  // Never `beforeExit`: Vite's loop can idle without exiting, and a close
  // there leaves Better Auth querying a dead client (`PGlite is closed`).
  process.once("SIGTERM", flush);
  process.once("SIGINT", flush);
}

async function openPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  const { PGlite } = await import("@electric-sql/pglite");
  const parsers = pgliteParsers();
  const resolved = resolvePgliteDataDir();
  const dataDir = resolved && ensurePgliteDataDir(resolved) ? resolved : undefined;

  try {
    const pg = new PGlite({
      parsers,
      relaxedDurability: false,
      ...(dataDir ? { dataDir } : {}),
    });
    await pg.waitReady;
    if (dataDir) {
      console.info("[db] PGLite persisting account data at", dataDir);
    } else {
      console.info("[db] PGLite in-memory (ephemeral)");
    }
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    registerPgliteShutdown();
    return pg;
  } catch (err) {
    if (!dataDir) throw err;
    // Locked or unreadable cluster (second process, corrupt files): do not
    // wipe the durable dir. Fall back to RAM so this process still serves.
    console.error("[db] durable PGLite failed, using in-memory fallback:", err);
    const pg = new PGlite({ parsers, relaxedDurability: false });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    registerPgliteShutdown();
    return pg;
  }
}

/**
 * Process-wide live PGLite. Reopen only when missing or `closed`.
 * Never close a healthy instance to change dataDir — Better Auth caches the
 * client, and that close is what made sandbox Google/X return
 * "Sign-in was cancelled or failed".
 */
async function livePglite(): Promise<import("@electric-sql/pglite").PGlite> {
  const wanted = resolvePgliteDataDir();
  const existingPromise = globalRef.__pgliteInstance__;
  if (existingPromise) {
    try {
      const existing = await existingPromise;
      if (!shouldReopenPglite(existing)) return existing;
    } catch {
      // previous open failed
    }
    if (globalRef.__pgliteInstance__ === existingPromise) clearPgliteSlot();
  }
  globalRef.__pgliteDataDir__ = wanted;
  globalRef.__pgliteInstance__ ??= openPglite().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  return globalRef.__pgliteInstance__;
}

async function createPgliteSql(): Promise<Sql> {
  // One PGLite instance per process, shared across HMR. Sandbox live preview
  // writes the cluster under /workspace/artifacts/pglite so account projects
  // survive Vite restarts and execution changes. Production uses Neon.
  const pg = await livePglite();

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  const migrate = async (): Promise<void> => {
    const live = await livePglite();
    const migrations = import.meta.glob("/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const doneRows = await live.query<{ name: string }>(
      "select name from _migrations",
    );
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      await live.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  // Resolve the live instance per query so a closed handle from HMR / a
  // mistaken close cannot poison every later Better Auth or account write.
  return toSql(async <T>(text: string, params: unknown[]) => {
    const live = await livePglite();
    const result = await live.query<T>(text, params);
    return result.rows;
  });
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  return dbSource === "neon" ? createNeonSql() : createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Neon when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql`, auto-applied before the first query on
 * both backends — define tables there, never inline in server functions.
 */
export function getSql(): Promise<Sql> {
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Neon).
 * Reopens when the previous handle is `closed`.
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  await getSql();
  const pg = await livePglite();
  if (!pg || pg.closed) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the durable (or in-memory)
 *   DB and apply `migrations/*.sql`. Idempotent — concurrent callers share one
 *   promise.
 * - **Neon**: no-op (pool is created lazily on first query).
 *
 * Vite `configureServer` awaits this at dev startup; production imports of this
 * module kick it off immediately (see bottom of file).
 */
export function ensureDbReady(): Promise<void> {
  if (dbSource !== "pglite") return Promise.resolve();
  return getSql().then(() => undefined);
}

// Server-only eager start: kick PGLite bootstrap as soon as this module loads in
// Node. Client bundles never hit this path (`getSql` throws in the browser).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && dbSource === "pglite") {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    // Never rethrow: an uncaught rejection here kills the Vercel isolate and
    // every route becomes HTTP 500 `{error:true,unhandled:true}`. getSql() retries.
  });
}
