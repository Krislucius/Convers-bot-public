#!/usr/bin/env node
/**
 * Inject Council sweeper crons into Vercel Build Output config.json.
 * Does not edit scripts/patch-nitro-ssr.mjs (runtime shell).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COUNCIL_SWEEP_PATH = "/api/council/sweep";
export const COUNCIL_SWEEP_SCHEDULE = "* * * * *";
export const COUNCIL_SWEEP_INTERVAL_MS = 60_000;

const here = dirname(fileURLToPath(import.meta.url));

export function councilCronEntries() {
  return [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }];
}

export function applyCouncilCrons(config) {
  const parsed = config && typeof config === "object" ? { ...config } : { version: 3 };
  const existing = Array.isArray(parsed.crons) ? parsed.crons : [];
  const next = [...existing];
  for (const row of councilCronEntries()) {
    const hit = next.find((item) => item && item.path === row.path);
    if (hit) hit.schedule = row.schedule;
    else next.push({ ...row });
  }
  parsed.crons = next;
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
  const next = applyCouncilCrons(parsed);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, path: configPath, crons: next.crons, written: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = writeCouncilCrons();
  if (!result.ok) {
    console.error(`[council-cron] ${result.error}`);
    process.exit(1);
  }
  console.log(`[council-cron] wrote ${result.crons.map((row) => `${row.schedule} ${row.path}`).join(", ")}`);
}
