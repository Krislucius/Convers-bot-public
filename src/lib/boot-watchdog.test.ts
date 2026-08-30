import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BOOT_READY_FLAG, BOOT_WATCHDOG_INLINE, BOOT_WATCHDOG_MS } from "./boot-watchdog.ts";

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

  it("treats a rendered guest shell as already recovered", () => {
    assert.match(BOOT_WATCHDOG_INLINE, /data-cb-shell="guest"/);
    assert.match(BOOT_WATCHDOG_INLINE, /data-cb-shell="app"/);
  });
});
