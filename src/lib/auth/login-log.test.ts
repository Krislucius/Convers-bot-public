import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLoginLog } from "../auth-trace.ts";

describe("login log", () => {
  it("prints a brief stage line and redacts secrets", () => {
    const text = formatLoginLog({
      stage: "boot-stuck",
      token: "live-secret",
      password: "hunter2",
      iframe: false,
    });
    assert.match(text, /stage: boot-stuck/);
    assert.match(text, /token: \[redacted\]/);
    assert.match(text, /password: \[redacted\]/);
    assert.equal(text.includes("live-secret"), false);
    assert.equal(text.includes("hunter2"), false);
  });

  it("always includes iframe and returning flags", () => {
    const text = formatLoginLog({ stage: "boot", label: "Loading your projects…" });
    assert.match(text, /iframe: [01]/);
    assert.match(text, /returning: [01]/);
    assert.match(text, /bearer: [01]/);
    assert.match(text, /label: Loading your projects/);
  });
});
