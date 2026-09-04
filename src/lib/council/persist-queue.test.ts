import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isRetryablePersistError,
  persistRetryDelay,
  runWithPersistRetry,
} from "./persist-queue.ts";

describe("persist retry", () => {
  it("delays 250ms, 500ms, 750ms", () => {
    assert.equal(persistRetryDelay(0), 250);
    assert.equal(persistRetryDelay(1), 500);
    assert.equal(persistRetryDelay(2), 750);
  });

  it("retries Unauthorized and closed PGLite, not validation errors", () => {
    assert.equal(isRetryablePersistError(new Error("Unauthorized")), true);
    assert.equal(isRetryablePersistError(new Error("PGlite is closed")), true);
    assert.equal(isRetryablePersistError(new Error("Failed to fetch")), true);
    assert.equal(isRetryablePersistError(new Error("Paste a key first.")), false);
  });

  it("returns on the first success", async () => {
    let n = 0;
    const value = await runWithPersistRetry(async () => {
      n += 1;
      return "ok";
    });
    assert.equal(value, "ok");
    assert.equal(n, 1);
  });

  it("retries Unauthorized then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const value = await runWithPersistRetry(
      async () => {
        n += 1;
        if (n < 3) throw new Error("Unauthorized");
        return "saved";
      },
      { sleep: async (ms) => { waits.push(ms); } },
    );
    assert.equal(value, "saved");
    assert.equal(n, 3);
    assert.deepEqual(waits, [250, 500]);
  });

  it("does not retry a non-retryable error", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        runWithPersistRetry(async () => {
          n += 1;
          throw new Error("Paste a key first.");
        }),
      /Paste a key first/,
    );
    assert.equal(n, 1);
  });
});
