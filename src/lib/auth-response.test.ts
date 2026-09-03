import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeAuthResponse,
  isAuthCallbackPath,
  isOAuthStartPath,
  isPopupHandoffPath,
  mergeSetCookies,
  safeLeaveUrl,
  safeNextPath,
  sessionTokenFromAuthHeaders,
  sessionTokenFromSetCookie,
} from "./auth-response.ts";

test("reads __Host- session token from Set-Cookie", () => {
  const token = sessionTokenFromSetCookie([
    "better-auth.state=abc; Path=/; HttpOnly",
    "__Host-grok-auth.session_token=sess.tok%2Ben; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
    "grok-auth.debug=nope; Path=/",
  ]);
  assert.equal(token, "sess.tok+en");
});

test("returns null when no session cookie", () => {
  assert.equal(sessionTokenFromSetCookie(["better-auth.state=abc; Path=/"]), null);
});

test("prefers set-auth-token header for bearer handoff", () => {
  const headers = new Headers({ "set-auth-token": "handed.token" });
  assert.equal(
    sessionTokenFromAuthHeaders(headers, [
      "__Host-grok-auth.session_token=cookie.token; Path=/; HttpOnly",
    ]),
    "handed.token",
  );
});

test("merges Set-Cookie lists with primary winning", () => {
  const merged = mergeSetCookies(
    ["__Host-grok-auth.session_token=good; Path=/"],
    ["__Host-grok-auth.session_token=stale; Path=/", "better-auth.state=abc; Path=/"],
  );
  assert.equal(
    merged.find((cookie) => cookie.startsWith("__Host-grok-auth.session_token=")),
    "__Host-grok-auth.session_token=good; Path=/",
  );
  assert.ok(merged.some((cookie) => cookie.startsWith("better-auth.state=")));
});

test("path helpers identify callback and oauth-start", () => {
  assert.equal(isAuthCallbackPath("/api/auth/oauth2/callback/grok-google"), true);
  assert.equal(isOAuthStartPath("/api/oauth-start/grok-google"), true);
  assert.equal(isAuthCallbackPath("/api/oauth-start/grok-google"), false);
});

test("safeLeaveUrl keeps broker https URLs and rejects javascript", () => {
  const req = "https://app.example/api/oauth-start/grok-google";
  assert.equal(
    safeLeaveUrl("https://auth.grok.me/api/auth/oauth2/authorize?x=1", req),
    "https://auth.grok.me/api/auth/oauth2/authorize?x=1",
  );
  assert.equal(safeLeaveUrl("javascript:alert(1)", req), null);
});

test("safeNextPath keeps login error query", () => {
  assert.equal(safeNextPath("/login?error=oauth", false), "/login?error=oauth");
  assert.equal(safeNextPath("https://app.example/signed-in", true), "/");
  assert.equal(isPopupHandoffPath("https://app.example/auth/popup?done=1"), true);
  assert.equal(safeNextPath("https://app.example/auth/popup?done=1", true), "/auth/popup?done=1");
});

test("oauth-start external 302 becomes same-origin leave HTML", async () => {
  const request = new Request("http://127.0.0.1:8080/api/oauth-start/grok-google");
  const response = new Response(null, {
    status: 302,
    headers: [
      ["location", "https://auth.grok.me/api/auth/oauth2/authorize?idp=google"],
      ["set-cookie", "better-auth.state=abc; Path=/; HttpOnly; Secure; SameSite=Lax"],
    ],
  });
  const out = await finalizeAuthResponse(request, response, Date.now());
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(out.headers.get("location"), null);
  assert.match(out.headers.get("content-security-policy") ?? "", /frame-ancestors/);
  const cookies = out.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("better-auth.state=")));
  const html = await out.text();
  assert.match(html, /data-cb-oauth-leave/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /auth\.grok\.me/);
  assert.doesNotMatch(html, /http-equiv="refresh"/i);
});

test("oauth-start error 302 stays on login", async () => {
  const request = new Request("http://127.0.0.1:8080/api/oauth-start/grok-google");
  const response = new Response(null, {
    status: 302,
    headers: { location: "http://127.0.0.1:8080/login?error=oauth-init" },
  });
  const out = await finalizeAuthResponse(request, response, Date.now());
  assert.equal(out.status, 302);
  assert.match(out.headers.get("location") ?? "", /\/login\?error=oauth-init/);
});

test("oauth callback with session returns HTML handoff to /", async () => {
  const request = new Request(
    "http://127.0.0.1:8080/api/auth/oauth2/callback/grok-google?code=fake",
  );
  const response = new Response(null, {
    status: 302,
    headers: [
      ["location", "http://127.0.0.1:8080/"],
      [
        "set-cookie",
        "__Host-grok-auth.session_token=sess.tok; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
      ],
      ["set-auth-token", "sess.tok"],
    ],
  });
  const out = await finalizeAuthResponse(request, response, Date.now());
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(out.headers.get("location"), null);
  assert.ok(
    out.headers.getSetCookie().some((cookie) => cookie.includes("grok-auth.session_token=sess.tok")),
  );
  const html = await out.text();
  assert.match(html, /sessionStorage\.setItem/);
  assert.match(html, /location\.replace/);
  assert.match(html, /postMessage/);
  assert.match(html, /grok-auth-popup/);
  assert.doesNotMatch(html, /get-session/);
  assert.match(html, /http-equiv="refresh"/);
});

test("popup callback 302 to /auth/popup is not rewritten to bounce HTML", async () => {
  const request = new Request(
    "http://127.0.0.1:8080/api/auth/oauth2/callback/grok-google?code=fake",
  );
  const response = new Response(null, {
    status: 302,
    headers: [
      ["location", "http://127.0.0.1:8080/auth/popup?done=1"],
      [
        "set-cookie",
        "__Host-grok-auth.session_token=sess.tok; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax",
      ],
      ["set-auth-token", "sess.tok"],
    ],
  });
  const out = await finalizeAuthResponse(request, response, Date.now());
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("location"), "http://127.0.0.1:8080/auth/popup?done=1");
});

test("failed callback 302 goes to login", async () => {
  const request = new Request("http://127.0.0.1:8080/api/auth/oauth2/callback/grok-google");
  const response = new Response(null, {
    status: 302,
    headers: { location: "http://127.0.0.1:8080/login?error=oauth" },
  });
  const out = await finalizeAuthResponse(request, response, Date.now());
  assert.equal(out.status, 302);
  assert.match(out.headers.get("location") ?? "", /\/login\?error=oauth/);
});
