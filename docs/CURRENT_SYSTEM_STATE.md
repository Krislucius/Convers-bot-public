# Current system state

Revision: CB-ARCH-20260901-002
Recorded: 2026-09-02T15:40:00.000Z

Factual state of the authoritative tree. Not a backlog.

## ACTIVE MODULES

- app.shell, auth.session, auth.loop-breaker
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

Auth is ON. Better Auth + Grok broker. Google, X, email/password. Session required for account data. `VITE_AUTH_ENABLED` is `"true"` in `.grok/app-env.json`. Root `beforeLoad` never awaits the session RPC on the client; SSR session fetch is capped at 4s. Client `useSession().isPending` expires after 5s so a hung `/api/auth/get-session` becomes the guest shell. Any React-mounted shell (guest / boot / app / error) marks the client ready so the boot watchdog cannot overlay a started UI. Framed hosts (sandbox preview and the published Grok iframe) start Google/X in a popup; the callback posts the session token to the opener instead of navigating the iframe to the broker. `getSession` after sign-in is bounded at 5s.

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

- Production Publish is a user action; git `CB-BUILD-20260902-011` is not `PROD_SYNC` until that host serves this `BUILD_ID`.
- Production FUNCTIONALITY READY requires a real browser smoke to an interactive UI. HTTP 200 / bundles / identity / auth-health are necessary but not sufficient.
- Nitro Vercel SSR barrels that re-export undefined `ssr_exports` are patched in the nitro `compiled` and `close` hooks during `vite build` (`scripts/patch-nitro-ssr.mjs`), then again from `npm run build`. The same hook writes missing Vercel `config.json` / `.vc-config.json` (the user compiled hook replaces Nitro's generateFunctionFiles). PGLite `pglite.data`, `pglite.wasm`, and `initdb.wasm` are staged next to the bundled driver. Eager PGLite bootstrap failures are logged and do not kill the isolate. Production uses Neon.
