import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  COUNCIL_SWEEP_PATH,
  COUNCIL_SWEEP_SCHEDULE,
  applyCouncilCrons,
} from "./council-cron-output.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("vercel.json registers the independent Council sweeper cron", () => {
  const parsed = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
  assert.ok(Array.isArray(parsed.crons));
  const hit = parsed.crons.find((row) => row.path === COUNCIL_SWEEP_PATH);
  assert.ok(hit);
  assert.equal(hit.schedule, COUNCIL_SWEEP_SCHEDULE);
  assert.equal(COUNCIL_SWEEP_SCHEDULE, "* * * * *");
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
