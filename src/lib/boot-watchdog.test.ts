import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BOOT_READY_FLAG,
  BOOT_READY_SCRIPT,
  BOOT_STUCK_MS,
  BOOT_WATCHDOG_INLINE,
  BOOT_WATCHDOG_MS,
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
    assert.match(BOOT_WATCHDOG_INLINE, /\/login/);
    assert.equal(BOOT_WATCHDOG_INLINE.includes("justify-center"), false);
  });
});
