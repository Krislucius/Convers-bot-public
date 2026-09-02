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
      bootStuck: Boolean(document.getElementById("cb-boot-stuck")),
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

  {
    const { page, errors } = await openPage(async (page) => {
      await page.route("**/assets/**", (route) => route.abort());
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(8500);
    const snap = await shellSnapshot(page);
    if (snap.bootFail || /did not finish loading/i.test(snap.body) || /did not finish loading/i.test(snap.watchdogText)) {
      fail("ssr-without-js: watchdog overlay", { snap, errors });
    }
    if (!snap.guest || !snap.oauth) fail("ssr-without-js: guest shell missing", { snap });
    results.ssrWithoutJs = snap;
    await page.close();
  }

  {
    const { page } = await openPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const watchdog = await page.evaluate(() => {
      const scripts = [...document.scripts].map((x) => x.textContent || "").filter(Boolean);
      return scripts.find((t) => t.includes("cb-boot-fail") && t.includes("setTimeout")) || scripts.find((t) => t.includes("__CB_CLIENT_READY")) || "";
    });
    await page.close();
    if (!watchdog) fail("boot-shell-only: watchdog script missing from SSR HTML");
    const isolated = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await isolated.setContent(
      `<!doctype html><html><body><script>${watchdog}</script><div data-cb-shell="boot"><p>Loading your projects…</p></div></body></html>`,
    );
    await isolated.waitForTimeout(8500);
    const snap = await shellSnapshot(isolated);
    if (snap.bootFail || /did not finish loading/i.test(snap.watchdogText)) {
      fail("boot-shell-only: watchdog overlay on SSR boot shell", { snap });
    }
    if (!snap.boot) fail("boot-shell-only: boot shell missing", { snap });
    if (!snap.ready) fail("boot-shell-only: ready flag not set from rendered shell", { snap });
    results.bootShellOnly = snap;
    await isolated.close();
  }

  {
    const { page, errors } = await openPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      queueMicrotask(() => {
        throw new Error("hydration-client-exception");
      });
    });
    await page.waitForTimeout(500);
    const snap = await shellSnapshot(page);
    if (snap.bootFail || /did not finish loading/i.test(snap.body)) {
      fail("hydration-exception: watchdog overlay", { snap, errors });
    }
    if (!snap.guest && !snap.app && !snap.error) fail("hydration-exception: shell gone", { snap });
    results.hydrationException = { ...snap, pageErrors: errors.pageErrors };
    await page.close();
  }

  {
    const sessionBody = JSON.stringify({
      user: { id: "u-boot-stress", name: "Boot", email: "boot@example.com" },
      session: { id: "s-boot-stress", token: "tok" },
    });
    const baked = 'window.__CB_SSR_SESSION={"id":"u-boot-stress","email":"boot@example.com"};';
    const { page, errors } = await openPage(async (page) => {
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (req.resourceType() === "document") {
          const resp = await route.fetch();
          let body = await resp.text();
          body = body.replace(/window\.__CB_SSR_SESSION=null;?/, baked);
          return route.fulfill({ response: resp, body });
        }
        if (req.url().includes("/api/auth/get-session")) {
          return route.fulfill({ status: 200, contentType: "application/json", body: sessionBody });
        }
        if (req.method() === "POST" && !req.url().includes("/api/auth/")) {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          return route.abort();
        }
        return route.continue();
      });
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(9500);
    const snap = await shellSnapshot(page);
    if (snap.bootFail || /did not finish loading/i.test(snap.body) || /did not finish loading/i.test(snap.watchdogText)) {
      fail("authed-hydrate-hang: blank watchdog overlay", { snap, errors });
    }
    if (snap.boot && !snap.error && !snap.app) {
      fail("authed-hydrate-hang: still Loading your projects", { snap, errors });
    }
    results.authedHydrateHang = snap;
    await page.close();
  }

  {
    const { page } = await openPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const watchdog = await page.evaluate(() => {
      const scripts = [...document.scripts].map((x) => x.textContent || "").filter(Boolean);
      return scripts.find((t) => t.includes("cb-boot-fail") && t.includes("setTimeout")) || scripts.find((t) => t.includes("__CB_CLIENT_READY")) || "";
    });
    await page.close();
    if (!watchdog) fail("boot-stuck: watchdog script missing from SSR HTML");
    const isolated = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await isolated.setContent(
      `<!doctype html><html><body><script>${watchdog}</script><div data-cb-shell="boot"><p>Loading your projects…</p></div></body></html>`,
    );
    await isolated.waitForTimeout(12_500);
    const snap = await shellSnapshot(isolated);
    if (snap.bootFail || /did not finish loading/i.test(snap.watchdogText)) {
      fail("boot-stuck: blank overlay on SSR boot shell", { snap });
    }
    if (!snap.bootStuck && !snap.error) fail("boot-stuck: no hydrate timeout recovery", { snap });
    results.bootStuck = snap;
    await isolated.close();
  }

  console.log(JSON.stringify({ ok: true, url, results }, null, 2));
} catch (err) {
  fail(String(err?.message || err));
} finally {
  await browser.close();
}
