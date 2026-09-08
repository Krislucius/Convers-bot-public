import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyHealth, healthScoreBoost, recordHealth } from "./model-health.ts";

describe("model health", () => {
  it("does not permanently zero reliability after one timeout", () => {
    const one = recordHealth(emptyHealth("kimi/k2"), {
      modelId: "kimi/k2",
      at: "2026-09-08T18:00:00.000Z",
      kind: "probe",
      outcome: "timeout",
      latencyMs: 2500,
      httpStatus: 0,
    });
    assert.ok(one.reliability >= 0.35);
    const recovered = recordHealth(one, {
      modelId: "kimi/k2",
      at: "2026-09-08T18:01:00.000Z",
      kind: "runtime",
      outcome: "success",
      latencyMs: 800,
      httpStatus: 200,
    });
    assert.ok(recovered.reliability > one.reliability);
  });

  it("penalizes slow and failing models in ranking boost", () => {
    let health = emptyHealth("slow/model");
    for (let i = 0; i < 4; i += 1) {
      health = recordHealth(health, {
        modelId: "slow/model",
        at: "2026-09-08T18:00:00.000Z",
        kind: "runtime",
        outcome: i === 3 ? "success" : "failure",
        latencyMs: 9000,
        httpStatus: 500,
      });
    }
    assert.ok(healthScoreBoost(health) < 0);
    const fast = recordHealth(emptyHealth("fast/model"), {
      modelId: "fast/model",
      at: "2026-09-08T18:00:00.000Z",
      kind: "probe",
      outcome: "success",
      latencyMs: 200,
      httpStatus: 200,
    });
    assert.ok(healthScoreBoost(fast) >= 0);
  });
});
