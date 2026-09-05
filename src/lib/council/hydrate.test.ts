import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HYDRATE_TIMEOUT_MS,
  HydrateTimeoutError,
  loadHydratePayload,
  runSerialQueries,
  UNAUTHORIZED_ATTEMPTS,
  withTimeout,
} from "./hydrate.ts";
import {
  NEON_POOL_CONNECTION_TIMEOUT_MS,
  NEON_POOL_MAX,
  NEON_QUERY_TIMEOUT_MS,
  neonPoolConfig,
} from "../db-pool.ts";
import type { AccountSettingsPublic, StoreShape } from "./types.ts";

const emptySnapshot: StoreShape = {
  projects: [],
  context: [],
  tasks: [],
  responses: [],
  results: [],
  chatSources: [],
  historyMessages: [],
  projectFiles: [],
  artifacts: [],
  manifests: [],
  packets: [],
};

const emptySettings: AccountSettingsPublic = {
  provider: "nanogpt",
  selectedModelIds: ["gpt", "claude"],
  synthesizerModel: "",
  catalog: null,
  gptModel: "gpt",
  grokModel: "grok",
  claudeModel: "claude",
  maxCostUsd: 1,
  lastTestLog: "",
  lastTestAt: null,
  lastTestOk: null,
  nanogpt: { saved: false, masked: "" },
  openrouter: { saved: false, masked: "" },
  openrusrouter: { saved: false, masked: "" },
};

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

describe("hydrate timeout", () => {
  it("rejects a hanging snapshot within the bound", async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        loadHydratePayload({
          loadSnapshot: hang,
          loadSettings: async () => emptySettings,
          timeoutMs: 40,
        }),
      (err: unknown) => err instanceof HydrateTimeoutError,
    );
    assert.ok(Date.now() - started < 500);
  });

  it("stress: 40 concurrent hanging hydrates all time out", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        loadHydratePayload({
          loadSnapshot: hang,
          loadSettings: hang,
          timeoutMs: 30,
        }),
      ),
    );
    assert.equal(results.length, 40);
    for (const row of results) {
      assert.equal(row.status, "rejected");
      if (row.status === "rejected") assert.ok(row.reason instanceof HydrateTimeoutError);
    }
  });

  it("retries Unauthorized then succeeds", async () => {
    let calls = 0;
    const out = await loadHydratePayload({
      timeoutMs: 200,
      sleep: async () => undefined,
      loadSnapshot: async () => {
        calls += 1;
        if (calls < 2) throw new Error("Unauthorized");
        return emptySnapshot;
      },
      loadSettings: async () => emptySettings,
    });
    assert.equal(out.snapshot.projects.length, 0);
    assert.equal(calls, 2);
  });

  it("does not retry forever on Unauthorized", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        loadHydratePayload({
          timeoutMs: 200,
          sleep: async () => undefined,
          loadSnapshot: async () => {
            calls += 1;
            throw new Error("Unauthorized");
          },
          loadSettings: async () => emptySettings,
        }),
      (err: unknown) => err instanceof Error && err.message === "Unauthorized",
    );
    assert.equal(calls, UNAUTHORIZED_ATTEMPTS);
  });

  it("loads an empty account", async () => {
    const out = await loadHydratePayload({
      loadSnapshot: async () => emptySnapshot,
      loadSettings: async () => emptySettings,
      timeoutMs: 100,
    });
    assert.deepEqual(out.snapshot.projects, []);
    assert.equal(out.settings.provider, "nanogpt");
  });

  it("maps a large project list without hanging", async () => {
    const snapshot: StoreShape = {
      ...emptySnapshot,
      projects: Array.from({ length: 500 }, (_, i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
        description: "",
        createdAt: "2026-01-01T00:00:00.000Z",
      })),
    };
    const out = await loadHydratePayload({
      loadSnapshot: async () => snapshot,
      loadSettings: async () => emptySettings,
      timeoutMs: 200,
    });
    assert.equal(out.snapshot.projects.length, 500);
  });
});

describe("serial snapshot queries", () => {
  it("never runs more than one query at a time under contention", async () => {
    let inFlight = 0;
    let peak = 0;
    const queries = Array.from({ length: 24 }, (_, i) => async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return i;
    });
    const rows = await runSerialQueries(queries);
    assert.equal(rows.length, 24);
    assert.equal(peak, 1);
  });
});

describe("withTimeout", () => {
  it("resolves a fast value", async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  });

  it("uses the default hydrate budget constant", () => {
    assert.equal(HYDRATE_TIMEOUT_MS, 8_000);
  });
});

describe("neon pool", () => {
  it("caps serverless connections and sets JS query timeouts (no pgbouncer SET)", () => {
    const cfg = neonPoolConfig("postgres://neon/db");
    assert.equal(cfg.max, NEON_POOL_MAX);
    assert.ok(cfg.max <= 2);
    assert.equal(cfg.connectionTimeoutMillis, NEON_POOL_CONNECTION_TIMEOUT_MS);
    assert.equal(cfg.query_timeout, NEON_QUERY_TIMEOUT_MS);
    assert.equal("options" in cfg, false);
  });
});

describe("single hydrate load", () => {
  it("accepts a combined loader", async () => {
    const out = await loadHydratePayload({
      timeoutMs: 100,
      load: async () => ({ snapshot: emptySnapshot, settings: emptySettings }),
    });
    assert.equal(out.settings.provider, "nanogpt");
  });

  it("stress: 80 concurrent hanging combined loads all time out", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 80 }, () =>
        loadHydratePayload({
          load: hang,
          timeoutMs: 25,
        }),
      ),
    );
    assert.equal(results.length, 80);
    for (const row of results) {
      assert.equal(row.status, "rejected");
      if (row.status === "rejected") assert.ok(row.reason instanceof HydrateTimeoutError);
    }
  });
});
