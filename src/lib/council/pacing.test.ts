import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  boundedBackoffMs,
  createSerialGate,
  diagnoseInternalStage,
  interRequestDelayMs,
  parseRetryAfter,
  retryWaitMs,
  stallAfterIdle,
  TEST_PACING,
} from "./pacing.ts";

describe("pacing", () => {
  it("parses Retry-After delta-seconds and HTTP-date", () => {
    assert.equal(parseRetryAfter("3"), 3000);
    assert.equal(parseRetryAfter(""), null);
    const now = Date.parse("2026-09-08T18:00:00.000Z");
    assert.equal(parseRetryAfter("Tue, 08 Sep 2026 18:00:05 GMT", now), 5000);
  });

  it("honors Retry-After exactly on 429, capped at 20s", () => {
    assert.equal(
      retryWaitMs({ attempt: 1, errorClass: "RATE_LIMITED", httpClass: "429", retryAfterHeader: "7" }),
      7000,
    );
    assert.equal(
      retryWaitMs({ attempt: 1, errorClass: "RATE_LIMITED", httpClass: "429", retryAfterHeader: "90" }),
      20_000,
    );
  });

  it("uses 2s/4s/8s cap 12s for 5xx/network", () => {
    const pacing = { backoffBaseMs: 2000, backoffCapMs: 12000, interRequestMs: 0, jitterMs: 0, retryAfterCapMs: 20000 };
    assert.equal(boundedBackoffMs(1, pacing), 2000);
    assert.equal(boundedBackoffMs(2, pacing), 4000);
    assert.equal(boundedBackoffMs(3, pacing), 8000);
    assert.equal(boundedBackoffMs(4, pacing), 12000);
    assert.equal(retryWaitMs({ attempt: 1, errorClass: "TIMEOUT", httpClass: "timeout", pacing }), 2000);
  });

  it("does not retry-delay when test pacing is zero", () => {
    assert.equal(retryWaitMs({ attempt: 2, errorClass: "NETWORK_ERROR", pacing: TEST_PACING }), 0);
    assert.equal(interRequestDelayMs(TEST_PACING), 0);
  });

  it("serial gate rejects overlapping calls", async () => {
    const gate = createSerialGate();
    let release = () => undefined as void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(async () => {
      await hold;
      return 1;
    });
    await assert.rejects(() => gate.run(async () => 2), /CONCURRENT_PROVIDER_CALL/);
    release();
    assert.equal(await first, 1);
  });

  it("names stall stages instead of silent WAITING", () => {
    assert.equal(diagnoseInternalStage({ leaseHeld: true }), "LEASE_WAIT");
    assert.equal(diagnoseInternalStage({ preflightDone: false }), "PREFLIGHT");
    assert.equal(diagnoseInternalStage({ preflightDone: true, providerCallsStarted: false }), "DISPATCH_PENDING");
    assert.equal(diagnoseInternalStage({ failed: true }), "FAILED");
    assert.equal(stallAfterIdle({ lastActivityAt: new Date(Date.now() - 9000).toISOString(), nowMs: Date.now() }), true);
    assert.equal(stallAfterIdle({ lastActivityAt: new Date().toISOString(), nowMs: Date.now() }), false);
  });
});
