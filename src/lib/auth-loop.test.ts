import assert from "node:assert/strict";
import test from "node:test";
import {
  accountShellKind,
  extractSessionToken,
  isAuthFramed,
  MAX_AUTO_LANDS,
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
