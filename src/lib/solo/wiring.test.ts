import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("solo wiring", () => {
  it("does not call Council orchestration or the global provider", () => {
    const page = source("../../routes/p.$projectId.solo.tsx");
    const api = source("./api.ts");
    const turn = source("./turn.server.ts");
    for (const file of [page, api, turn]) {
      assert.equal(file.includes("runCouncil"), false);
      assert.equal(file.includes("startCouncilRun"), false);
      assert.equal(file.includes("setProvider"), false);
      assert.equal(file.includes("durable-step"), false);
    }
    assert.equal(page.includes("handoffSnapshot"), true);
    assert.equal(page.includes("SOLO_THREAD"), false);
    assert.match(source("./logic.ts"), /provenance: "SOLO_THREAD"/);
    assert.equal(page.includes("sendSoloFn"), true);
    assert.equal(page.includes("setUiLanguage"), false);
  });

  it("keeps Council handoff on the completed result and does not start a run from that button", () => {
    const task = source("../../routes/t.$taskId.tsx");
    const discuss = task.slice(task.indexOf("async function onDiscuss"));
    assert.match(discuss, /createSoloThreadFn/);
    assert.equal(discuss.slice(0, discuss.indexOf("async function onRun") > -1 ? discuss.indexOf("function onRun") : 800).includes("startCouncilRun"), false);
  });
});
