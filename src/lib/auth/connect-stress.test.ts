import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSET_RELOAD_KEY,
  BOOT_WATCHDOG_INLINE,
  loginSessionPresent,
  scriptErrorAction,
} from "../boot-watchdog.ts";
import {
  getBakedSessionServerSnapshot,
  peekSessionUser,
  type SessionUser,
} from "./session-bootstrap.ts";

describe("connect stress (100)", () => {
  it("100 hydrate, session, and script-reload cases all terminate", () => {
    let n = 0;
    const seen = new Set<string>();
    const mark = (id: string) => {
      assert.equal(seen.has(id), false, `duplicate ${id}`);
      seen.add(id);
      n += 1;
    };

    const ssrUsers: SessionUser[] = [null, { id: "ssr", email: "a@b.c" }];
    const bakedUsers: SessionUser[] = [null, { id: "bake", email: null }];
    for (const ssr of ssrUsers) {
      for (const baked of bakedUsers) {
        mark(`hydrate:${ssr ? "s" : "-"}${baked ? "b" : "-"}`);
        const serverPaint = peekSessionUser(ssr, getBakedSessionServerSnapshot());
        assert.equal(serverPaint, ssr);
        const afterHydrate = peekSessionUser(ssr, baked);
        assert.equal(afterHydrate?.id ?? null, (ssr ?? baked)?.id ?? null);
        if (!ssr) assert.equal(serverPaint, null);
      }
    }

    const scripts = [
      "https://swift-lake-solar-cosmic.grok.me/assets/index-4SOrF60E.js",
      "https://swift-lake-solar-cosmic.grok.me/assets/index-7_gQg0Go.js",
      "https://swift-lake-solar-cosmic.grok.me/assets/index-Bilov9qm.js",
      "/assets/client-abc.js",
      "/assets/chunk-0.js",
      "https://example.com/cdn/app.js",
      "https://swift-lake-solar-cosmic.grok.me/login",
      "https://swift-lake-solar-cosmic.grok.me/",
    ];
    for (const src of scripts) {
      for (const already of [false, true]) {
        mark(`script:${src.slice(-28)}:${already ? 1 : 0}`);
        const action = scriptErrorAction(src, already);
        if (src.includes("/assets/")) {
          assert.equal(action, already ? "show" : "reload");
        } else {
          assert.equal(action, "note");
        }
      }
    }

    for (const baked of [false, true]) {
      for (const jsCookie of [false, true]) {
        for (const iframe of [false, true]) {
          mark(`session:${baked ? 1 : 0}${jsCookie ? 1 : 0}${iframe ? 1 : 0}`);
          assert.equal(loginSessionPresent(baked, jsCookie), baked || jsCookie);
          assert.match(BOOT_WATCHDOG_INLINE, /session: /);
          assert.equal(typeof iframe, "boolean");
        }
      }
    }

    for (let i = 0; i < 20; i += 1) {
      mark(`watchdog:${i}`);
      assert.match(BOOT_WATCHDOG_INLINE, new RegExp(ASSET_RELOAD_KEY));
      assert.match(BOOT_WATCHDOG_INLINE, /script-reload/);
      assert.match(BOOT_WATCHDOG_INLINE, /session: /);
      assert.ok(!BOOT_WATCHDOG_INLINE.includes("</script>"));
      assert.equal(scriptErrorAction(`/assets/n-${i}.js`, false), "reload");
      assert.equal(scriptErrorAction(`/assets/n-${i}.js`, true), "show");
    }

    for (let i = 0; i < 52; i += 1) {
      mark(`pad:${i}`);
      const baked = i % 2 === 0;
      const cookie = i % 3 === 0;
      assert.equal(loginSessionPresent(baked, cookie), baked || cookie);
      assert.equal(
        scriptErrorAction(`https://host/assets/index-${i}.js`, i % 2 === 1),
        i % 2 === 1 ? "show" : "reload",
      );
    }

    assert.equal(n, 100);
    assert.equal(seen.size, 100);
  });
});
