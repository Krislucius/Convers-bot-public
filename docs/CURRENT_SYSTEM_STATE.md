# Current system state

Revision: CB-ARCH-20260901-001
Recorded: 2026-09-01T00:00:00.000Z

Factual state of the authoritative tree. Not a backlog.

## ACTIVE MODULES

- app.shell, auth.session, auth.loop-breaker
- persist.postgres, account.persistence
- history.ingest, files.ingest
- council.task-mode, council.protocol, council.orchestrator, council.manifest, council.artifact, council.providers
- context.pipeline (chunks → ledger → ranked packer)
- context.evidence-ledger
- ui.settings (includes system identity)
- architecture.lock

## CURRENT DATA MODEL

Postgres tables from migrations `0001`–`0005`: Better Auth identity; `account_settings`; `projects`; `context_items`; `tasks`; `agent_responses`; `council_results`; `chat_sources`; `history_messages`; `context_manifests`; `artifacts`; `project_files`; `evidence_chunks`; `evidence_items`; `extractor_cache`. All app tables carry `user_id`.

## CURRENT AUTHENTICATION

Auth is ON. Better Auth + Grok broker. Google, X, email/password. Session required for account data. `VITE_AUTH_ENABLED` is `"true"` in `.grok/app-env.json`.

## CURRENT PROVIDER

OpenRouter (`sk-or-…`) and OpenRusRouter (`orr_live_…`). Keys persist on `account_settings`. Models and `max_cost_usd` persist with the account.

## CURRENT COUNCIL FLOW

`src/routes/t.$taskId.tsx` → `runCouncil` in `src/lib/council/orchestrate.ts` only. CREATE / REVIEW / DECIDE. Round 1, Round 2, synthesis.

## CURRENT CONTEXT PIPELINE

`runEvidencePipeline` chunks every selected chat/file, extracts non-canonical ledger claims, then packs mandatory canonical context plus ranked evidence into 6 000 tokens via `countTokens`. No character slice. Incomplete coverage blocks Council. Truncated stored extracts require re-import.

## CURRENT DEPLOYMENT

Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d` → `https://swift-lake-solar-cosmic.grok.me`.

## CURRENT BLOCKER TRACKS

Reporting contract: `docs/SERVICE_STATUS.md`. Functionality and build workflow are independent. Do not mix the lists.

### FUNCTIONALITY

Standing constraints (not defects): truncated sources without recoverable raw text are `REIMPORT_REQUIRED`; extractor cache is in-memory; provider keys are account-scoped DB text.

FUNCTION BLOCKERS: none.

### BUILD WORKFLOW

- Production Publish is a user action; git `CB-BUILD-20260901-002` is not `PROD_SYNC` until that host serves this `BUILD_ID`.
- Local built-output preview omits PGLite wasm/data from the Vercel function output. Production uses Neon.
