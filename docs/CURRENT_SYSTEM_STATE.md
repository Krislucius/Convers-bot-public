# Current system state

Revision: CB-ARCH-20260901-002
Recorded: 2026-09-04T07:20:00.000Z

Factual state of the authoritative tree. Not a backlog.

## ACTIVE MODULES

- app.shell, auth.session, auth.loop-breaker, runtime.shell-gate
- persist.postgres, account.persistence
- history.ingest, files.ingest
- council.task-mode, council.protocol, council.orchestrator, council.manifest, council.artifact, council.providers
- council.packet, council.review, council.evaluate
- context.pipeline (chunks → ledger → ranked packer)
- context.evidence-ledger
- ui.settings (includes system identity)
- architecture.lock

## CURRENT DATA MODEL

Postgres tables from migrations `0001`–`0006`: Better Auth identity; `account_settings`; `projects`; `context_items`; `tasks`; `agent_responses`; `council_results` (including `review_verdict` and `structured`); `chat_sources`; `history_messages`; `context_manifests`; `artifacts`; `project_files`; `evidence_chunks`; `evidence_items`; `extractor_cache`; `implementation_packets`. All app tables carry `user_id`.

## CURRENT AUTHENTICATION

Auth is ON. Better Auth + Grok broker. Google, X, email/password. Session required for account data. `VITE_AUTH_ENABLED` is `"true"` in `.grok/app-env.json`. Root `beforeLoad` never awaits the session RPC on the client; SSR session fetch is capped at 4s. Client `useSession().isPending` expires after 5s so a hung `/api/auth/get-session` becomes the guest shell. Any rendered `data-cb-shell` (guest / boot / app / error) is a started UI: the boot watchdog must not overlay it, even if React effects have not run. Parse-time ready scripts and DOMContentLoaded mark `__CB_CLIENT_READY`. A boot shell that is still boot after 12s is a hydrate stall: the watchdog turns it into an error with Retry, Open workspace anyway, and Sign out (POST `/api/auth/sign-out` then `/login?stay=1` so login does not auto-land back into boot). Account hydrate has an 8s wall-clock independent of the RPC. Signed-in first paint uses the SSR session prop. The baked `__CB_SSR_SESSION` script is read only through `useSyncExternalStore` (server snapshot is always null) so a guest SSR document cannot mismatch a client that sees a bake — that was React #418. `getBakedSessionSnapshot` returns the same object when the bake is unchanged; a new object every call was React #185 (maximum update depth) on signed-in 017. The router error screen has Reload and Sign out. Boot, hydrate-error, and stuck-boot screens include a collapsible Login log (stage, session vs js-visible cookie, baked, iframe, React mount vs parse-time ready, last errors including minified React #418, last auth/fetch status; secrets redacted). `session: 1` when bake or a js-visible cookie is present — HttpOnly `__Host-grok-auth.session_token` is expected to show `cookie: 0`. A hashed `/assets/` script load error auto-reloads once (`cb-asset-reload`), then shows the overlay. Vercel routes: missing `/assets/*` return 404 `no-store` instead of SSR HTML (HTML-as-JS plus immutable cache was the 016 `script: index-….js` / `react: 0` failure). HTML responses send `Content-Security-Policy: frame-ancestors 'self' https://grok.com https://*.grok.com https://*.grok.me` and `Cross-Origin-Resource-Policy: cross-origin` so the Grok preview iframe is not `ERR_BLOCKED_BY_RESPONSE`. Framed hosts (sandbox preview and the published Grok iframe) start Google/X in a popup; `/auth/popup` and `/api/oauth-start` return same-origin leave HTML instead of 302-ing the overlay to Google (Google's X-Frame-Options was Chrome `ERR_BLOCKED_BY_RESPONSE` in the preview). Top-level windows jump to the broker; framed overlays keep a `target=_blank` Continue link. The callback posts the session token via `postMessage` and `BroadcastChannel`. Explicit Sign out always POSTs `/api/auth/sign-out` (even without a bearer — popup Google can leave a first-party cookie), sets `grok-auth.signed-out`, and lands on `/login?stay=1` so auto-land cannot drop the visitor back into the last account. `getSession` after sign-in is bounded at 5s.

## CURRENT PROVIDER

OpenRouter (`sk-or-…`) and OpenRusRouter (`orr_live_…`). Keys persist on `account_settings`. Models and `max_cost_usd` persist with the account.

## CURRENT COUNCIL FLOW

`src/routes/t.$taskId.tsx` → `runCouncil` in `src/lib/council/orchestrate.ts` only. CREATE / REVIEW / DECIDE. Round 1, Round 2, structured synthesis. Two surviving agents are enough. CREATE APPROVED writes an Implementation Packet. REVIEW returns PASS / PATCH / BLOCKED. DECIDE disagreements or CONFLICTED evidence require USER_DECISION_REQUIRED. Progress is persisted on `tasks.diagnostics.run` (stage, timestamps, per-agent state, `run_id`). Stop marks `CANCELLED` and keeps partial agent rows. Restart issues a new `run_id` and drops stale writes from the previous generation.

## CURRENT CONTEXT PIPELINE

`runEvidencePipeline` chunks every selected chat/file, extracts non-canonical ledger claims, then packs mandatory canonical context plus ranked evidence into 6 000 tokens via incremental `countTokens`. The task UI caches one pipeline result per source/task fingerprint and Run reuses that prepared object. Incomplete coverage blocks Council. Truncated stored extracts require re-import. Invalid citations are demoted.

## CURRENT CLOSED LOOP

Implementation Packet JSON is the Build handoff. Direct Build execution is unavailable and is not simulated. Packet states: READY → HANDED_OFF → RESULT_RECORDED → REVIEW_OPEN → CLOSED (PASS/BLOCKED) or READY (PATCH). Evaluation summary lives on the project Tasks page.

## CURRENT DEPLOYMENT

Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d` → `https://swift-lake-solar-cosmic.grok.me`.

## CURRENT BLOCKER TRACKS

Reporting contract: `docs/SERVICE_STATUS.md`. Functionality and build workflow are independent. Do not mix the lists.

### FUNCTIONALITY

Standing constraints (not defects): truncated sources without recoverable raw text are `REIMPORT_REQUIRED`; extractor cache is in-memory; provider keys are account-scoped DB text; direct Build execution is unavailable so packets stay first-class handoff JSON.

FUNCTION BLOCKERS: none.

### BUILD WORKFLOW

- Production Publish is a user action; git `CB-BUILD-20260904-020` is not `PROD_SYNC` until that host serves this `BUILD_ID`.
- Production FUNCTIONALITY READY requires a real browser smoke to an interactive UI. HTTP 200 / bundles / identity / auth-health are necessary but not sufficient.
- The protected runtime shell is `docs/RUNTIME_SHELL.json`. `npm run shell:gate` (hash, product-vs-shell scope, no client `.server` imports, production build, built-browser smoke) must pass before a release. Functional Council/evidence/history patches that also change shell files fail with `SHELL_SCOPE_VIOLATION`.
- Nitro Vercel SSR barrels that re-export undefined `ssr_exports` are patched in the nitro `compiled` and `close` hooks during `vite build` (`scripts/patch-nitro-ssr.mjs`), then again from `npm run build`. The same hook writes Vercel `config.json` / `.vc-config.json` and **rewrites** them when routes drift (missing hashed `/assets/*` 404 instead of SSR; CSP `frame-ancestors` for grok.com). PGLite `pglite.data`, `pglite.wasm`, and `initdb.wasm` are staged next to the bundled driver. Eager PGLite bootstrap failures are logged and do not kill the isolate. Production uses Neon.
