import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COUNCIL_SWEEP_PATH,
  COUNCIL_SWEEP_SCHEDULE,
  applyCouncilCrons,
  cronKey,
  reconcileCouncilCrons,
  vercelJsonDeclaresSweep,
} from "./council-cron-output.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("vercel.json is the single declared Council sweeper cron", () => {
  const parsed = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
  assert.ok(Array.isArray(parsed.crons));
  const hits = parsed.crons.filter((row) => row.path === COUNCIL_SWEEP_PATH);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].schedule, COUNCIL_SWEEP_SCHEDULE);
  assert.equal(COUNCIL_SWEEP_SCHEDULE, "* * * * *");
  assert.equal(vercelJsonDeclaresSweep(root), true);
});

test("applyCouncilCrons injects the sweeper without dropping routes", () => {
  const next = applyCouncilCrons({
    version: 3,
    routes: [{ src: "/(.*)", dest: "/__server" }],
  });
  assert.equal(next.version, 3);
  assert.equal(next.routes.length, 1);
  assert.deepEqual(next.crons, [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }]);
  const again = applyCouncilCrons(next);
  assert.equal(again.crons.length, 1);
});

test("reconcile strips the sweeper from config.json when vercel.json already declares it", () => {
  const vercel = [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }];
  const next = reconcileCouncilCrons(
    {
      version: 3,
      routes: [{ src: "/(.*)", dest: "/__server" }],
      crons: [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }],
    },
    vercel,
  );
  assert.equal(next.version, 3);
  assert.equal(next.routes.length, 1);
  assert.equal(next.crons, undefined);
  const keys = [...vercel, ...(next.crons ?? [])].map(cronKey);
  assert.equal(new Set(keys).size, keys.length);
});

test("reconcile injects into config.json only when vercel.json has no sweeper", () => {
  const next = reconcileCouncilCrons(
    { version: 3, routes: [{ src: "/(.*)", dest: "/__server" }] },
    [],
  );
  assert.deepEqual(next.crons, [{ path: COUNCIL_SWEEP_PATH, schedule: COUNCIL_SWEEP_SCHEDULE }]);
});
