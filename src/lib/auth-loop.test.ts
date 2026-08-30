import assert from "node:assert/strict";
import test from "node:test";
import { accountShellKind, extractSessionToken, MAX_AUTO_LANDS } from "./auth-loop.ts";

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
