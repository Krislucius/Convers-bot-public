#!/usr/bin/env node
/**
 * Council sweeper cron is declared once, in vercel.json.
 * Grok/Vercel merge vercel.json crons with .vercel/output/config.json crons.
 * Injecting the same path+schedule into config.json produced:
 * "A duplicated cron job with the same schedule (* * * * *) and path (/api/council/sweep)"
 *
 * This script keeps vercel.json as the single source. After Nitro writes
 * config.json it strips the sweeper from that file when vercel.json already
 * declares it. It only injects into config.json if vercel.json is missing
 * the entry (Build Output API fallback). Does not edit patch-nitro-ssr.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COUNCIL_SWEEP_PATH = "/api/council/sweep";
export const COUNCIL_SWEEP_SCHEDULE = "* * * * *";
export const COUNCIL_SWEEP_INTERVAL_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export function councilCronEntries() {
  return [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }];
}

export function cronKey(row) {
  return `${row?.schedule ?? ""} ${row?.path ?? ""}`;
}

export function dedupeCrons(crons) {
  const seen = new Set();
  const next = [];
  for (const row of crons ?? []) {
    if (!row || typeof row.path !== "string" || !row.path) continue;
    const key = cronKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push({ path: row.path, schedule: row.schedule });
  }
  return next;
}

export function readVercelJsonCrons(fromRoot = root) {
  const path = join(fromRoot, "vercel.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed.crons) ? parsed.crons : [];
  } catch {
    return [];
  }
}

export function vercelJsonDeclaresSweep(fromRoot = root) {
  return readVercelJsonCrons(fromRoot).some(
    (row) => row && row.path === COUNCIL_SWEEP_PATH && row.schedule === COUNCIL_SWEEP_SCHEDULE,
  );
}

export function stripMatchingCrons(crons, remove) {
  const drop = new Set((remove ?? []).map(cronKey));
  return (crons ?? []).filter((row) => !drop.has(cronKey(row)));
}

/** Fallback only: used when vercel.json does not declare the sweeper. */
export function applyCouncilCrons(config) {
  const parsed = config && typeof config === "object" ? { ...config } : { version: 3 };
  const existing = Array.isArray(parsed.crons) ? parsed.crons : [];
  parsed.crons = dedupeCrons([...existing, ...councilCronEntries()]);
  return parsed;
}

/**
 * Single registration. If vercel.json already has the sweeper, strip it from
 * Build Output config.json so the platform does not merge a duplicate.
 */
export function reconcileCouncilCrons(config, vercelCrons) {
  const parsed = config && typeof config === "object" ? { ...config } : { version: 3 };
  const declared = Array.isArray(vercelCrons) ? vercelCrons : [];
  const hasSweep = declared.some(
    (row) => row && row.path === COUNCIL_SWEEP_PATH && row.schedule === COUNCIL_SWEEP_SCHEDULE,
  );
  const existing = Array.isArray(parsed.crons) ? parsed.crons : [];
  if (hasSweep) {
    const stripped = stripMatchingCrons(existing, councilCronEntries());
    if (stripped.length) parsed.crons = dedupeCrons(stripped);
    else delete parsed.crons;
    return parsed;
  }
  parsed.crons = dedupeCrons([...existing, ...councilCronEntries()]);
  return parsed;
}

export function writeCouncilCrons(outputDir) {
  const dir = outputDir ?? join(here, "..", ".vercel", "output");
  const configPath = join(dir, "config.json");
  if (!existsSync(configPath)) {
    return { ok: false, error: `missing ${configPath}`, written: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), written: false };
  }
  const vercelCrons = readVercelJsonCrons(root);
  const next = reconcileCouncilCrons(parsed, vercelCrons);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ok: true,
    path: configPath,
    crons: next.crons ?? [],
    source: vercelJsonDeclaresSweep(root) ? "vercel.json" : "config.json",
    written: true,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writeCouncilCrons();
  if (!result.ok) {
    console.error(`[council-cron] ${result.error}`);
    process.exit(1);
  }
  const listed = result.crons.length
    ? result.crons.map((row) => `${row.schedule} ${row.path}`).join(", ")
    : "(none in config.json)";
  console.log(`[council-cron] ${result.source} owns the sweeper; config.json crons: ${listed}`);
}
