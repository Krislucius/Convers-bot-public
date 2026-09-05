# Current system state

Revision: CB-ARCH-20260905-004
Recorded: 2026-09-05T19:55:00.000Z

Factual state of the authoritative tree. Not a backlog.

## ACTIVE MODULES

- app.shell, auth.session, auth.loop-breaker, runtime.shell-gate
- persist.postgres, account.persistence
- history.ingest, files.ingest
- council.task-mode, council.protocol, council.orchestrator, council.manifest, council.artifact, council.providers, council.discovery
- council.packet, council.review, council.evaluate
- context.pipeline (chunks → ledger → ranked packer)
- context.evidence-ledger
- ui.settings (includes system identity)
- architecture.lock

## CURRENT DATA MODEL

Postgres tables from migrations `0001`–`0009`: Better Auth identity; `account_settings` (including `nanogpt_key`, `selected_model_ids`, `synthesizer_model`, `model_catalog`, `last_test_log`, `last_test_at`, `last_test_ok`); `projects`; `context_items`; `tasks` (including frozen `provider` and `selected_models`); `agent_responses`; `council_results` (including `review_verdict` and `structured`); `chat_sources`; `history_messages`; `context_manifests`; `artifacts`; `project_files`; `evidence_chunks`; `evidence_items`; `extractor_cache`; `implementation_packets`. All app tables carry `user_id`. Sandbox without `DATABASE_URL` persists the PGLite cluster at `/workspace/artifacts/pglite` so signed-in account projects and API keys survive Vite restarts and execution changes; production uses Neon. The process never closes a healthy PGLite handle to swap dataDir (that left Better Auth on a dead client and sandbox Google/X returned "Sign-in was cancelled or failed" / `PGlite is closed`). Closed handles reopen. Account writes `CHECKPOINT` the cluster. The live-preview Better Auth signing secret is stored at `/workspace/artifacts/grok-auth-preview-secret` so a process restart does not mint a new secret against durable users. Client project/key writes no longer wait on `accountBound` (that dropped the first save when hydrate lagged or HMR reset the flag) and retry Unauthorized / closed-PGLite. Settings Test discovers the provider catalog and probes actual account access, then Save writes the key and selected Council models to the account, so a failed test cannot swallow the secret. The client Zustand account store is kept on `window.__cbAccountStore__` so an HMR reload of the store module does not blank the workspace.

## CURRENT AUTHENTICATION

Auth is ON. Better Auth + Grok broker. Google, X, email/password. Session required for account data. `VITE_AUTH_ENABLED` is `"true"` in `.grok/app-env.json`. Root `beforeLoad` never awaits the session RPC on the client; SSR session fetch is capped at 4s. Client `useSession().isPending` expires after 5s so a hung `/api/auth/get-session` becomes the guest shell. Any rendered `data-cb-shell` (guest / boot / app / error) is a started UI: the boot watchdog must not overlay it, even if React effects have not run. Parse-time ready scripts and DOMContentLoaded mark `__CB_CLIENT_READY`. A boot shell that is still boot after 12s is a hydrate stall: the watchdog turns it into an error with Retry, Open workspace anyway, and Sign out (POST `/api/auth/sign-out` then `/login?stay=1` so login does not auto-land back into boot). Account hydrate has an 8s wall-clock independent of the RPC. Signed-in first paint uses the SSR session prop. The baked `__CB_SSR_SESSION` script is read only through `useSyncExternalStore` (server snapshot is always null) so a guest SSR document cannot mismatch a client that sees a bake — that was React #418. `getBakedSessionSnapshot` returns the same object when the bake is unchanged; a new object every call was React #185 (maximum update depth) on signed-in 017. The router error screen has Reload and Sign out. Boot, hydrate-error, and stuck-boot screens include a collapsible Login log (stage, session vs js-visible cookie, baked, iframe, React mount vs parse-time ready, last errors including minified React #418, last auth/fetch status; secrets redacted). `session: 1` when bake or a js-visible cookie is present — HttpOnly `__Host-grok-auth.session_token` is expected to show `cookie: 0`. A hashed `/assets/` script load error auto-reloads once (`cb-asset-reload`), then shows the overlay. Vercel routes: missing `/assets/*` return 404 `no-store` instead of SSR HTML (HTML-as-JS plus immutable cache was the 016 `script: index-….js` / `react: 0` failure). HTML responses send `Content-Security-Policy: frame-ancestors 'self' https://grok.com https://*.grok.com https://*.grok.me` and `Cross-Origin-Resource-Policy: cross-origin` so the Grok preview iframe is not `ERR_BLOCKED_BY_RESPONSE`. Framed hosts (sandbox preview and the published Grok iframe) start Google/X in a popup; `/auth/popup` and `/api/oauth-start` return same-origin leave HTML instead of 302-ing the overlay to Google (Google's X-Frame-Options was Chrome `ERR_BLOCKED_BY_RESPONSE` in the preview). Top-level windows jump to the broker; framed overlays keep a `target=_blank` Continue link. The callback posts the session token via `postMessage` and `BroadcastChannel`. Explicit Sign out always POSTs `/api/auth/sign-out` (even without a bearer — popup Google can leave a first-party cookie), sets `grok-auth.signed-out`, and lands on `/login?stay=1` so auto-land cannot drop the visitor back into the last account. `getSession` after sign-in is bounded at 5s.

## CURRENT PROVIDER

Selectable API providers: NanoGPT (`sk-nano-…`) and OpenRouter (`sk-or-…`). OpenRusRouter remains available for existing `orr_live_…` keys. Settings Test fetches the selected provider catalog, normalizes the response (direct array or OpenAI `{ data: [...] }`), and probes whether this account can actually call recommended/selected models. Unsupported catalog shapes fail with `CATALOG_PARSE_ERROR`. Catalog presence is not treated as usable access. CONNECTED requires an authenticated provider check. Scan statuses: AVAILABLE / UNAVAILABLE / NOT_INCLUDED / UNKNOWN. Recommendations and Council membership use only AVAILABLE models from the current scan (3–5 diverse families, or fewer if that is all that is available). Before a paid Council run every selected model is pinged with a minimal authenticated completion; Council starts only when each selected id is VERIFIED_AVAILABLE. A catalog-visible subscription-denied model is NOT_INCLUDED and blocks the run. Provider brand names are not models. Grok is not injected when absent. Stale selected IDs are dropped on provider/catalog change. A failed Test Connection never shows a previous scan as current; the old catalog is STALE cached data. Test Connection always writes a sanitized persisted log (PASS and FAIL), including catalog HTTP status, response shape, and parse metadata. After save the browser does not keep the secret (`creds.apiKey` is empty); Council Run resolves the selected provider's key server-side. `assertRunCredentials` must not treat that empty client field as "not connected" when the account already shows READY for the selected provider. A leftover OpenRouter `sk-or-…` secret is not treated as a connected NanoGPT key, and a leftover NanoGPT secret is not treated as an OpenRouter key. Switching provider re-runs discovery and never mixes providers inside one run.

## CURRENT COUNCIL FLOW

`src/routes/t.$taskId.tsx` → `runCouncil` in `src/lib/council/orchestrate.ts` only. CREATE / REVIEW / DECIDE. Dynamic 2–5 selected models. Round 1 independent, Round 2 cross-review, structured synthesis from a selected surviving model. Two surviving agents are enough. Fewer than two survivors is a PARTIAL RESULT: FAILED, successful responses stay visible, synthesis is skipped with an explicit reason, Retry failed models / Replace failed models / Restart Council. Each model is one agent card (name, status, attempts n/m, last error = exact sanitized failure). CREATE APPROVED writes an Implementation Packet. REVIEW returns PASS / PATCH / BLOCKED. DECIDE disagreements or CONFLICTED evidence require USER_DECISION_REQUIRED. Progress is persisted on `tasks.diagnostics.run` (stage, timestamps, per-agent state, `run_id`, provider, members, request budget, cost telemetry, partial, synthesisSkipped). Stop marks `CANCELLED` and keeps partial agent rows. Restart issues a new `run_id` and drops stale writes from the previous generation. Catalog listing is not a start gate: a live selected-model verify blocks `MODEL_UNAVAILABLE` before paid `completeChat`. Empty completions are failures. Runtime failures keep provider, model, stage, HTTP status/class, attempt, and retry exhaustion — never "provider error". USD cost is telemetry; the hard gate is request attempts (for N=3: 7 expected / 12 ceiling). One selected provider and the selected models are frozen on the task for that run.

## CURRENT CONTEXT PIPELINE

`runEvidencePipeline` chunks every selected chat/file, extracts non-canonical ledger claims, then packs mandatory canonical context plus ranked evidence into 6 000 tokens via incremental `countTokens`. The task UI caches one pipeline result per source/task fingerprint and Run reuses that prepared object. Incomplete coverage blocks Council. Truncated stored extracts require re-import. Invalid citations are demoted.

## CURRENT CLOSED LOOP

Implementation Packet JSON is the Build handoff. Direct Build execution is unavailable and is not simulated. Packet states: READY → HANDED_OFF → RESULT_RECORDED → REVIEW_OPEN → CLOSED (PASS/BLOCKED) or READY (PATCH). Evaluation summary lives on the project Tasks page.

## CURRENT DEPLOYMENT

Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d` → `https://cb-gptgrokclaud.grok.me`.

## CURRENT BLOCKER TRACKS

Reporting contract: `docs/SERVICE_STATUS.md`. Functionality and build workflow are independent. Do not mix the lists.

### FUNCTIONALITY

Standing constraints (not defects): truncated sources without recoverable raw text are `REIMPORT_REQUIRED`; extractor cache is in-memory; provider keys are account-scoped DB text; direct Build execution is unavailable so packets stay first-class handoff JSON.

FUNCTION BLOCKERS: none.

### BUILD WORKFLOW

- Production Publish is a user action; git `CB-BUILD-20260905-004` is not `PROD_SYNC` until that host serves this `BUILD_ID`.
- Production FUNCTIONALITY READY requires a real browser smoke to an interactive UI. HTTP 200 / bundles / identity / auth-health are necessary but not sufficient.
- The protected runtime shell is `docs/RUNTIME_SHELL.json`. `npm run shell:gate` (hash, product-vs-shell scope, no client `.server` imports, production build, built-browser smoke) must pass before a release. Functional Council/evidence/history patches that also change shell files fail with `SHELL_SCOPE_VIOLATION`.
- Nitro Vercel SSR barrels that re-export undefined `ssr_exports` are patched in the nitro `compiled` and `close` hooks during `vite build` (`scripts/patch-nitro-ssr.mjs`), then again from `npm run build`. The same hook writes Vercel `config.json` / `.vc-config.json` and **rewrites** them when routes drift (missing hashed `/assets/*` 404 instead of SSR; CSP `frame-ancestors` for grok.com). PGLite `pglite.data`, `pglite.wasm`, and `initdb.wasm` are staged next to the bundled driver. Eager PGLite bootstrap failures are logged and do not kill the isolate. Production uses Neon. Sandbox PGLite is durable on disk (`artifacts/pglite`); a live process does not close that handle under Better Auth. Production preview and Vercel without `DATABASE_URL` stay in-memory.
