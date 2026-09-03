import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSET_RELOAD_KEY,
  BOOT_READY_FLAG,
  BOOT_READY_SCRIPT,
  BOOT_STUCK_MS,
  BOOT_WATCHDOG_INLINE,
  BOOT_WATCHDOG_MS,
  LOGIN_LOG_FLAG,
  REACT_MOUNTED_FLAG,
  SKIP_HYDRATE_KEY,
  loginSessionPresent,
  scriptErrorAction,
} from "./boot-watchdog.ts";

describe("boot watchdog", () => {
  it("inlines a bounded reload overlay and asset-error listener", () => {
    assert.equal(BOOT_WATCHDOG_MS, 8_000);
    assert.match(BOOT_WATCHDOG_INLINE, new RegExp(BOOT_READY_FLAG));
    assert.match(BOOT_WATCHDOG_INLINE, /Reload/);
    assert.match(BOOT_WATCHDOG_INLINE, /oauth-start/);
    assert.match(BOOT_WATCHDOG_INLINE, /\/assets\//);
    assert.match(BOOT_WATCHDOG_INLINE, /addEventListener\("error"/);
    assert.ok(!BOOT_WATCHDOG_INLINE.includes("</script>"));
  });

  it("treats any rendered shell as already started, including boot and error", () => {
    assert.match(BOOT_WATCHDOG_INLINE, /\[data-cb-shell\]/);
    assert.match(BOOT_WATCHDOG_INLINE, /DOMContentLoaded/);
    assert.match(BOOT_READY_SCRIPT, new RegExp(BOOT_READY_FLAG));
  });

  it("recovers a stuck authenticated boot shell without the blank-page overlay", () => {
    assert.equal(BOOT_STUCK_MS, 12_000);
    assert.ok(BOOT_STUCK_MS > BOOT_WATCHDOG_MS);
    assert.match(BOOT_WATCHDOG_INLINE, /cb-boot-stuck/);
    assert.match(BOOT_WATCHDOG_INLINE, /Loading projects timed out/);
    assert.match(BOOT_WATCHDOG_INLINE, /data-cb-shell="boot"/);
    assert.match(BOOT_WATCHDOG_INLINE, /\/login\?stay=1/);
    assert.match(BOOT_WATCHDOG_INLINE, /Sign out/);
    assert.match(BOOT_WATCHDOG_INLINE, /Open workspace anyway/);
    assert.match(BOOT_WATCHDOG_INLINE, /Login log/);
    assert.match(BOOT_WATCHDOG_INLINE, new RegExp(LOGIN_LOG_FLAG));
    assert.match(BOOT_WATCHDOG_INLINE, new RegExp(SKIP_HYDRATE_KEY));
    assert.match(BOOT_WATCHDOG_INLINE, /\/api\/auth\/sign-out/);
    assert.equal(BOOT_WATCHDOG_INLINE.includes("justify-center"), false);
  });

  it("records React mount vs parse-time ready and captures minified hydration errors", () => {
    assert.match(BOOT_WATCHDOG_INLINE, new RegExp(REACT_MOUNTED_FLAG));
    assert.match(BOOT_WATCHDOG_INLINE, /Minified React error/);
    assert.match(BOOT_WATCHDOG_INLINE, /#418/);
    assert.match(BOOT_WATCHDOG_INLINE, /console\.error/);
    assert.match(BOOT_WATCHDOG_INLINE, /react: /);
    assert.match(BOOT_WATCHDOG_INLINE, /\/api\/auth\//);
  });

  it("auto-reloads once on a hashed /assets/ script error and treats bake as session", () => {
    assert.match(BOOT_WATCHDOG_INLINE, new RegExp(ASSET_RELOAD_KEY));
    assert.match(BOOT_WATCHDOG_INLINE, /script-reload/);
    assert.match(BOOT_WATCHDOG_INLINE, /session: /);
    assert.equal(scriptErrorAction("https://host/assets/index-4SOrF60E.js", false), "reload");
    assert.equal(scriptErrorAction("https://host/assets/index-4SOrF60E.js", true), "show");
    assert.equal(scriptErrorAction("https://host/login", false), "note");
    assert.equal(loginSessionPresent(true, false), true);
    assert.equal(loginSessionPresent(false, true), true);
    assert.equal(loginSessionPresent(false, false), false);
  });
});
