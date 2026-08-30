# Current system state

Revision: CB-ARCH-20260829-001
Recorded: 2026-08-29T18:45:00.000Z

Factual state of the authoritative tree. Not a backlog.

## ACTIVE MODULES

- app.shell, auth.session, auth.loop-breaker
- persist.postgres, account.persistence
- history.ingest, files.ingest
- council.task-mode, council.protocol, council.orchestrator, council.manifest, council.artifact, council.providers
- context.pipeline (concat + boundContext 24k)
- ui.settings (includes system identity)
- architecture.lock

## CURRENT DATA MODEL

Postgres tables from migrations `0001`–`0004`: Better Auth identity; `account_settings`; `projects`; `context_items`; `tasks`; `agent_responses`; `council_results`; `chat_sources`; `history_messages`; `context_manifests`; `artifacts`; `project_files`. All app tables carry `user_id`.

## CURRENT AUTHENTICATION

Auth is ON. Better Auth + Grok broker. Google, X, email/password. Session required for account data. `VITE_AUTH_ENABLED` is `"true"` in `.grok/app-env.json`.

## CURRENT PROVIDER

OpenRouter (`sk-or-…`) and OpenRusRouter (`orr_live_…`). Keys persist on `account_settings`. Models and `max_cost_usd` persist with the account.

## CURRENT COUNCIL FLOW

`src/routes/t.$taskId.tsx` → `runCouncil` in `src/lib/council/orchestrate.ts` only. CREATE / REVIEW / DECIDE. Round 1, Round 2, synthesis.

## CURRENT CONTEXT PIPELINE

`selectedChatsToContext` + selected files + memory items → `buildContext` → `boundContext` (24 000 characters). No Evidence Ledger table. No hierarchical extraction.

## CURRENT DEPLOYMENT

Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d` → `https://swift-lake-solar-cosmic.grok.me`.

## CURRENT KNOWN BLOCKERS

- Hierarchical Evidence Ledger is not implemented (PROPOSED ADR-006). CREATE tasks with large histories are packed by first-N `boundContext`.
- Provider keys are account-scoped DB text, not application-level encryption beyond the database platform.
- `src/lib/council/task-mode.test.ts` previously failed under `node --test` because `manifest.ts` imported `@/lib` (fixed in this revision).
