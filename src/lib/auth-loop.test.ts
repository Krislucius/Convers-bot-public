import assert from "node:assert/strict";
import test from "node:test";
import {
  accountShellKind,
  AUTH_BROADCAST_CHANNEL,
  AUTH_POPUP_SOURCE,
  authPopupHandoffInlineScript,
  extractSessionToken,
  isAuthFramed,
  MAX_AUTO_LANDS,
  oauthPopupPath,
  OAUTH_LEAVE_FRAME_ANCESTORS,
  renderOAuthLeaveHtml,
  shouldPopupOAuth,
  tokenFromAuthPopupMessage,
  withDeadline,
} from "./auth-loop.ts";

test("auto-land allows only one bounce", () => {
  assert.equal(MAX_AUTO_LANDS, 1);
});

test("extracts bearer from Better Auth email payloads", () => {
  assert.equal(extractSessionToken({ token: "abc" }), "abc");
  assert.equal(extractSessionToken({ data: { token: "from-data" } }), "from-data");
  assert.equal(extractSessionToken({ data: { session: { token: "sess" } } }), "sess");
  assert.equal(extractSessionToken({ data: { user: { id: "1" } } }), null);
  assert.equal(extractSessionToken(null), null);
});

test("guest shell is used when neither SSR nor client has a user", () => {
  assert.equal(accountShellKind({ sessionUser: null, user: null }), "guest");
});

test("signed-in SSR skips the guest boot pulse", () => {
  assert.equal(accountShellKind({ sessionUser: { id: "u1" }, user: null }), "hydrator");
  assert.equal(accountShellKind({ sessionUser: null, user: { id: "u1" } }), "hydrator");
});

test("framed hosts and sandbox hosts must popup OAuth", () => {
  assert.equal(shouldPopupOAuth({ hostname: "swift-lake-solar-cosmic.grok.me", framed: true }), true);
  assert.equal(shouldPopupOAuth({ hostname: "swift-lake-solar-cosmic.grok.me", framed: false }), false);
  assert.equal(shouldPopupOAuth({ hostname: "abc.grok-sandbox.com", framed: false }), true);
  assert.equal(isAuthFramed({ self: 1, top: 1 }), false);
  assert.equal(isAuthFramed({ self: 1, top: 2 }), true);
});

test("popup path is /auth/popup in sandbox/dev and oauth-start when deployed", () => {
  assert.equal(
    oauthPopupPath("grok-google", { hostname: "abc.grok-sandbox.com", dev: false }),
    "/auth/popup?providerId=grok-google",
  );
  assert.equal(
    oauthPopupPath("grok-google", { hostname: "swift-lake-solar-cosmic.grok.me", dev: true }),
    "/auth/popup?providerId=grok-google",
  );
  assert.equal(
    oauthPopupPath("grok-google", { hostname: "swift-lake-solar-cosmic.grok.me", dev: false }),
    "/api/oauth-start/grok-google",
  );
});

test("popup postMessage only accepts same-origin grok-auth-popup", () => {
  assert.equal(
    tokenFromAuthPopupMessage({ source: "grok-auth-popup", token: "abc" }, "https://app.example", "https://app.example"),
    "abc",
  );
  assert.equal(
    tokenFromAuthPopupMessage({ source: "grok-auth-popup", token: "abc" }, "https://app.example", "https://evil.example"),
    undefined,
  );
  assert.equal(
    tokenFromAuthPopupMessage({ source: "other", token: "abc" }, "https://app.example", "https://app.example"),
    undefined,
  );
  assert.equal(
    tokenFromAuthPopupMessage({ source: "grok-auth-popup", token: null }, "https://app.example", "https://app.example"),
    null,
  );
});

test("withDeadline rejects a hanging promise", async () => {
  const started = Date.now();
  await assert.rejects(
    () => withDeadline(new Promise(() => undefined), 30, "signin-timeout"),
    /signin-timeout/,
  );
  assert.ok(Date.now() - started < 500);
});

test("OAuth leave HTML never 302s Google into a frame", () => {
  const url = "https://auth.grok.me/api/auth/oauth2/authorize?idp=google&x=<script>";
  const html = renderOAuthLeaveHtml(url);
  assert.match(html, /data-cb-oauth-leave/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="opener"/);
  assert.match(html, /window\.self !== window\.top/);
  assert.match(html, /location\.replace\(url\)/);
  assert.match(html, /if \(!framed\)/);
  assert.doesNotMatch(html, /http-equiv="refresh"/i);
  assert.ok(html.includes("<script>") || html.includes("\\u003cscript>"));
  assert.match(OAUTH_LEAVE_FRAME_ANCESTORS, /grok\.com/);
});

test("100 framed OAuth leave pages stay same-origin", () => {
  for (let i = 0; i < 100; i++) {
    const idp = i % 2 === 0 ? "google" : "twitter";
    const url = `https://auth.grok.me/api/auth/oauth2/authorize?idp=${idp}&n=${i}`;
    const html = renderOAuthLeaveHtml(url);
    assert.match(html, /data-cb-oauth-leave/);
    assert.match(html, /target="_blank"/);
    assert.doesNotMatch(html, /http-equiv="refresh"/i);
    assert.ok(html.includes(url) || html.includes(url.replace(/&/g, "&")));
    assert.match(html, /if \(!framed\)/);
  }
});

test("popup completion handoff uses BroadcastChannel and opener", () => {
  const script = authPopupHandoffInlineScript();
  assert.match(script, new RegExp(AUTH_BROADCAST_CHANNEL));
  assert.match(script, new RegExp(AUTH_POPUP_SOURCE));
  assert.match(script, /BroadcastChannel/);
  assert.match(script, /window\.opener/);
  assert.match(script, /window\.parent/);
});
