#!/usr/bin/env node
/**
 * Client-boot regression: guest cold load, reload, delayed/failed auth.
 * HTTP 200 is not success — the page must become an interactive shell
 * without the boot watchdog overlay or uncaught errors.
 */
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const timeoutMs = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS || 25000);

function fail(message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exit(1);
}

async function shellSnapshot(page) {
  return page.evaluate(() => {
    const fail = document.getElementById("cb-boot-fail");
    const buttons = [...document.querySelectorAll("a[href], button")].filter((el) => {
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    });
    return {
      ready: Boolean(window.__CB_CLIENT_READY),
      bootFail: Boolean(fail),
      watchdogText: fail ? fail.innerText.slice(0, 160) : "",
      guest: Boolean(document.querySelector('[data-cb-shell="guest"]')),
      app: Boolean(document.querySelector('[data-cb-shell="app"]')),
      boot: Boolean(document.querySelector('[data-cb-shell="boot"]')),
      error: Boolean(document.querySelector('[data-cb-shell="error"]')),
      oauth: Boolean(document.querySelector('a[href*="/api/oauth-start/"]')),
      interactive: buttons.length > 0,
      body: (document.body?.innerText || "").slice(0, 400),
    };
  });
}

function assertInteractiveGuest(label, snap, errors) {
  if (errors.pageErrors.length || errors.consoleErrors.length) {
    fail(`${label}: uncaught browser errors`, { errors, snap });
  }
  if (snap.bootFail || /did not finish loading/i.test(snap.body) || /did not finish loading/i.test(snap.watchdogText)) {
    fail(`${label}: watchdog overlay`, { snap });
  }
  if (!snap.guest && !snap.app && !snap.error) {
    fail(`${label}: no resolved shell`, { snap });
  }
  if (snap.guest && (!snap.oauth || !snap.interactive)) {
    fail(`${label}: login controls not interactive`, { snap });
  }
  if (!snap.ready && !snap.guest && !snap.app && !snap.error) {
    fail(`${label}: auth bootstrap did not terminate`, { snap });
  }
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const results = {};

  async function openPage(hook) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = { consoleErrors: [], pageErrors: [] };
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      // Chromium logs mocked 5xx/auth failures as console errors. Those are the
      // failed-auth case under test, not an uncaught app exception.
      if (/Failed to load resource:.*\b(4\d\d|5\d\d)\b/.test(text)) return;
      errors.consoleErrors.push(text);
    });
    page.on("pageerror", (err) => errors.pageErrors.push(String(err?.message || err)));
    if (hook) await hook(page);
    return { page, errors };
  }

  {
    const { page, errors } = await openPage();
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if ((resp?.status() ?? 0) >= 400) fail("guest cold load HTTP", { status: resp?.status() });
    await page.waitForTimeout(1500);
    const snap = await shellSnapshot(page);
    assertInteractiveGuest("guest-cold", snap, errors);
    results.guestCold = snap;
    await page.close();
  }

  {
    const { page, errors } = await openPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(800);
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1500);
    const snap = await shellSnapshot(page);
    assertInteractiveGuest("reload", snap, errors);
    results.reload = snap;
    await page.close();
  }

  {
    const { page, errors } = await openPage(async (page) => {
      await page.route("**/api/auth/get-session", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        await route.fulfill({ status: 200, contentType: "application/json", body: "null" });
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(2500);
    const snap = await shellSnapshot(page);
    assertInteractiveGuest("delayed-auth", snap, errors);
    results.delayedAuth = snap;
    await page.close();
  }

  {
    const { page, errors } = await openPage(async (page) => {
      await page.route("**/api/auth/get-session", async (route) => {
        await route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"nope\"}" });
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1500);
    const snap = await shellSnapshot(page);
    assertInteractiveGuest("failed-auth", snap, errors);
    results.failedAuth = snap;
    await page.close();
  }

  console.log(JSON.stringify({ ok: true, url, results }, null, 2));
} catch (err) {
  fail(String(err?.message || err));
} finally {
  await browser.close();
}
