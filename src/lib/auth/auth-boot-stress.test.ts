import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountShellKind, SESSION_WAIT_MS, withDeadline } from "../auth-loop.ts";
import {
  authBootstrapState,
  bakeSessionUserScript,
  boundAuthPending,
  clientExceptionOutcome,
  resolveRootSessionUser,
  shouldMarkClientReady,
  SSR_SESSION_MS,
} from "./session-bootstrap.ts";
import { HYDRATE_TIMEOUT_MS, HydrateTimeoutError, loadHydratePayload } from "../council/hydrate.ts";
import { BOOT_STUCK_MS, BOOT_WATCHDOG_MS } from "../boot-watchdog.ts";

function hang(): Promise<never> {
  return new Promise(() => undefined);
}

const emptySettings = {
  provider: "openrouter" as const,
  gptModel: "gpt",
  grokModel: "grok",
  claudeModel: "claude",
  maxCostUsd: 1,
  openrouter: { saved: false, masked: "" },
  openrusrouter: { saved: false, masked: "" },
};

const emptySnapshot = {
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

describe("auth boot stress (100)", () => {
  it("100 bootstrap, hydrate, and shell cases all terminate", async () => {
    let n = 0;
    const seen = new Set<string>();
    const mark = (id: string) => {
      assert.equal(seen.has(id), false, `duplicate ${id}`);
      seen.add(id);
      n += 1;
    };

    for (const user of [null, { id: "u1" }]) {
      for (const sessionUser of [null, { id: "u1" }]) {
        for (const isPending of [false, true]) {
          for (const elapsed of [0, SESSION_WAIT_MS]) {
            mark(`bootstrap:${user ? 1 : 0}${sessionUser ? 1 : 0}${isPending ? 1 : 0}${elapsed}`);
            const state = authBootstrapState({
              user,
              sessionUser,
              isPending,
              elapsedMs: elapsed,
            });
            assert.ok(state.status === "READY" || state.status === "RESOLVING");
            assert.ok(["guest", "boot", "app", "error"].includes(state.shell));
            if (!user && !sessionUser) {
              assert.equal(state.status, "READY");
              assert.equal(state.shell, "guest");
            }
            if (user || sessionUser) {
              assert.equal(state.shell, "boot");
              assert.equal(state.status, "RESOLVING");
            }
          }
        }
      }
    }

    for (const hydrateReady of [true, false]) {
      for (const hydrateError of [null, "fail"]) {
        mark(`hydrate-flag:${hydrateReady}:${hydrateError ?? "ok"}`);
        const state = authBootstrapState({
          user: { id: "u1" },
          sessionUser: { id: "u1" },
          isPending: false,
          elapsedMs: 0,
          hydrateReady,
          hydrateError,
        });
        if (hydrateError) {
          assert.equal(state.status, "ERROR");
          assert.equal(state.shell, "error");
        } else if (hydrateReady) {
          assert.equal(state.status, "READY");
          assert.equal(state.shell, "app");
        } else {
          assert.equal(state.status, "RESOLVING");
        }
      }
    }

    for (const failedAuth of [false, true]) {
      mark(`failed-auth:${failedAuth}`);
      const state = authBootstrapState({
        user: null,
        sessionUser: null,
        isPending: true,
        elapsedMs: 0,
        failedAuth,
      });
      assert.equal(state.shell, "guest");
      assert.equal(state.status, "READY");
      if (failedAuth) assert.equal(state.isPending, false);
    }

    for (const shell of ["guest", "app", "boot", "error", "none"] as const) {
      mark(`ready-flag:${shell}`);
      assert.equal(shouldMarkClientReady(shell), shell !== "none");
    }

    mark("client-exception");
    const outcome = clientExceptionOutcome();
    assert.equal(outcome.status, "ERROR");
    assert.equal(outcome.markReady, true);

    for (let i = 0; i < 12; i += 1) {
      mark(`pending-bound:${i}`);
      const elapsed = i * 1_000;
      const pending = boundAuthPending({ isPending: true, elapsedMs: elapsed });
      assert.equal(pending, elapsed < SESSION_WAIT_MS);
    }

    for (const failed of [true, false]) {
      mark(`pending-failed:${failed}`);
      assert.equal(boundAuthPending({ isPending: true, elapsedMs: 0, failed }), !failed);
    }

    for (let i = 0; i < 10; i += 1) {
      mark(`bake:${i}`);
      const email = i % 2 === 0 ? `a<${i}>@x.y` : `ok${i}@x.y`;
      const script = bakeSessionUserScript({ id: `u${i}`, email });
      assert.match(script, /window\.__CB_SSR_SESSION=/);
      assert.equal(script.includes("<"), false);
    }
    mark("bake-null");
    assert.match(bakeSessionUserScript(null), /window\.__CB_SSR_SESSION=null/);

    for (const sessionUser of [null, { id: "ssr" }]) {
      for (const user of [null, { id: "cli" }]) {
        mark(`kind:${sessionUser ? "s" : "-"}${user ? "c" : "-"}`);
        const kind = accountShellKind({ sessionUser, user });
        assert.equal(kind, sessionUser || user ? "hydrator" : "guest");
      }
    }

    for (let i = 0; i < 8; i += 1) {
      mark(`ssr-timeout:${i}`);
      const started = Date.now();
      const user = await resolveRootSessionUser({
        isClient: false,
        previous: null,
        fetchUser: hang,
        timeoutMs: 15 + i,
      });
      assert.equal(user, null);
      assert.ok(Date.now() - started < 400);
    }

    for (let i = 0; i < 6; i += 1) {
      mark(`client-no-wait:${i}`);
      let called = 0;
      const user = await resolveRootSessionUser({
        isClient: true,
        previous: i % 2 ? { id: `p${i}`, email: null } : null,
        fetchUser: async () => {
          called += 1;
          return hang();
        },
      });
      assert.equal(called, 0);
      if (i % 2) assert.equal(user?.id, `p${i}`);
      else assert.equal(user, null);
    }

    for (let i = 0; i < 6; i += 1) {
      mark(`ssr-throw:${i}`);
      const user = await resolveRootSessionUser({
        isClient: false,
        previous: i % 2 ? { id: "keep", email: null } : null,
        fetchUser: async () => {
          throw new Error(`boom-${i}`);
        },
      });
      if (i % 2) assert.equal(user?.id, "keep");
      else assert.equal(user, null);
    }

    for (let i = 0; i < 8; i += 1) {
      mark(`deadline:${i}`);
      await assert.rejects(() => withDeadline(hang(), 12 + i, "signin-timeout"), /signin-timeout/);
    }

    const hanging = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => {
        mark(`hydrate-hang:${i}`);
        return loadHydratePayload({
          loadSnapshot: hang,
          loadSettings: hang,
          timeoutMs: 25,
        });
      }),
    );
    for (const row of hanging) {
      assert.equal(row.status, "rejected");
      if (row.status === "rejected") assert.ok(row.reason instanceof HydrateTimeoutError);
    }

    for (let i = 0; i < 6; i += 1) {
      mark(`hydrate-empty:${i}`);
      const out = await loadHydratePayload({
        timeoutMs: 100,
        loadSnapshot: async () => emptySnapshot,
        loadSettings: async () => emptySettings,
      });
      assert.equal(out.snapshot.projects.length, 0);
    }

    mark("timeout-bounds");
    assert.ok(SSR_SESSION_MS < BOOT_WATCHDOG_MS);
    assert.ok(SESSION_WAIT_MS < BOOT_WATCHDOG_MS);
    assert.ok(HYDRATE_TIMEOUT_MS <= BOOT_STUCK_MS);
    assert.ok(BOOT_STUCK_MS > BOOT_WATCHDOG_MS);

    assert.equal(n, 100);
    assert.equal(seen.size, 100);
  });
});
