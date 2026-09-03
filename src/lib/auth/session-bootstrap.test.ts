import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_WAIT_MS } from "../auth-loop.ts";
import {
  SSR_SESSION_MS,
  authBootstrapState,
  bakeSessionUserScript,
  boundAuthPending,
  clientExceptionOutcome,
  resolveRootSessionUser,
  shouldMarkClientReady,
  getBakedSessionServerSnapshot,
  getBakedSessionSnapshot,
  peekSessionUser,
  resetBakedSessionSnapshotCache,
} from "./session-bootstrap.ts";

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

describe("resolveRootSessionUser", () => {
  it("guest cold load / client reload never waits on the session RPC", async () => {
    let called = 0;
    const user = await resolveRootSessionUser({
      isClient: true,
      previous: null,
      fetchUser: async () => {
        called += 1;
        return hang();
      },
    });
    assert.equal(user, null);
    assert.equal(called, 0);
  });

  it("client reuse of SSR session does not refetch", async () => {
    let called = 0;
    const previous = { id: "u1", email: "a@b.c" };
    const user = await resolveRootSessionUser({
      isClient: true,
      previous,
      fetchUser: async () => {
        called += 1;
        return { id: "other", email: null };
      },
    });
    assert.equal(user, previous);
    assert.equal(called, 0);
  });

  it("bakes a session script without HTML breakouts", () => {
    const script = bakeSessionUserScript({ id: "u1", email: "a<b>@c.d" });
    assert.match(script, /window\.__CB_SSR_SESSION=/);
    assert.equal(script.includes("<"), false);
    assert.match(script, /u003c/);
  });

  it("SSR times out a hanging provider and returns guest", async () => {
    const started = Date.now();
    const user = await resolveRootSessionUser({
      isClient: false,
      previous: null,
      fetchUser: hang,
      timeoutMs: 40,
    });
    assert.equal(user, null);
    assert.ok(Date.now() - started < 500);
  });

  it("failed auth response on SSR becomes guest, not a throw", async () => {
    const user = await resolveRootSessionUser({
      isClient: false,
      previous: null,
      fetchUser: async () => {
        throw new Error("get-session 500");
      },
    });
    assert.equal(user, null);
  });

  it("SSR timeout bound is under the boot watchdog", () => {
    assert.ok(SSR_SESSION_MS < 8_000);
    assert.ok(SESSION_WAIT_MS < 8_000);
  });
});

describe("auth bootstrap terminates", () => {
  it("guest cold load is READY without a session", () => {
    const state = authBootstrapState({
      user: null,
      sessionUser: null,
      isPending: true,
      elapsedMs: 0,
    });
    assert.equal(state.status, "READY");
    assert.equal(state.shell, "guest");
    assert.equal(state.isPending, false);
    assert.equal(shouldMarkClientReady(state.shell), true);
  });

  it("delayed auth pending expires so the guest shell is not infinite", () => {
    assert.equal(boundAuthPending({ isPending: true, elapsedMs: 0 }), true);
    assert.equal(boundAuthPending({ isPending: true, elapsedMs: SESSION_WAIT_MS }), false);
    const state = authBootstrapState({
      user: null,
      sessionUser: null,
      isPending: true,
      elapsedMs: SESSION_WAIT_MS,
    });
    assert.equal(state.status, "READY");
    assert.equal(state.shell, "guest");
  });

  it("failed auth response is READY guest, not RESOLVING", () => {
    const state = authBootstrapState({
      user: null,
      sessionUser: null,
      isPending: true,
      elapsedMs: 0,
      failedAuth: true,
    });
    assert.equal(state.status, "READY");
    assert.equal(state.shell, "guest");
    assert.equal(state.isPending, false);
  });

  it("hydration/client exception is ERROR and marks ready", () => {
    const outcome = clientExceptionOutcome();
    assert.equal(outcome.status, "ERROR");
    assert.equal(outcome.shell, "error");
    assert.equal(outcome.markReady, true);
    assert.equal(shouldMarkClientReady("error"), true);
    const state = authBootstrapState({
      user: { id: "u1" },
      sessionUser: { id: "u1" },
      isPending: false,
      elapsedMs: 0,
      hydrateError: "Hydration failed",
    });
    assert.equal(state.status, "ERROR");
    assert.equal(state.shell, "error");
  });

  it("authenticated hydrate is RESOLVING then READY, never infinite", () => {
    const loading = authBootstrapState({
      user: { id: "u1" },
      sessionUser: { id: "u1" },
      isPending: false,
      elapsedMs: 0,
      hydrateReady: false,
    });
    assert.equal(loading.status, "RESOLVING");
    assert.equal(loading.shell, "boot");
    assert.equal(shouldMarkClientReady(loading.shell), true);

    const ready = authBootstrapState({
      user: { id: "u1" },
      sessionUser: { id: "u1" },
      isPending: false,
      elapsedMs: 100,
      hydrateReady: true,
    });
    assert.equal(ready.status, "READY");
    assert.equal(ready.shell, "app");
  });

  it("no shell and no ready flag is the only infinite-loading case", () => {
    assert.equal(shouldMarkClientReady("none"), false);
    for (const shell of ["guest", "app", "boot", "error"] as const) {
      assert.equal(shouldMarkClientReady(shell), true);
    }
  });
});

describe("hydration-safe baked session", () => {
  it("server snapshot is always null so guest SSR cannot mismatch a bake", () => {
    assert.equal(getBakedSessionServerSnapshot(), null);
  });

  it("prefers the SSR prop over bake and never reads bake on the server snapshot", () => {
    const ssr = { id: "ssr", email: "a@b.c" };
    const baked = { id: "bake", email: null };
    assert.equal(peekSessionUser(ssr, baked), ssr);
    assert.equal(peekSessionUser(null, null), null);
    assert.equal(peekSessionUser(null, baked), baked);
    const firstPaint = peekSessionUser(null, getBakedSessionServerSnapshot());
    assert.equal(firstPaint, null);
  });

  it("getSnapshot is referentially stable so a signed-in bake cannot #185", () => {
    resetBakedSessionSnapshotCache();
    const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
    const prev = (globalThis as { window?: unknown }).window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { __CB_SSR_SESSION: { id: "u1", email: "a@b.c" } },
    });
    try {
      const a = getBakedSessionSnapshot();
      assert.equal(a?.id, "u1");
      for (let i = 0; i < 80; i += 1) {
        assert.equal(getBakedSessionSnapshot(), a);
      }
      (globalThis as unknown as { window: { __CB_SSR_SESSION: unknown } }).window.__CB_SSR_SESSION = {
        id: "u2",
        email: null,
      };
      const next = getBakedSessionSnapshot();
      assert.equal(next?.id, "u2");
      assert.notEqual(next, a);
      assert.equal(getBakedSessionSnapshot(), next);
    } finally {
      if (hadWindow) {
        (globalThis as { window?: unknown }).window = prev;
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      resetBakedSessionSnapshotCache();
    }
  });
});
