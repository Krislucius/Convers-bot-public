# Conversation Bot architecture

Current revision: **CB-ARCH-20260905-003**

This document describes the system that is running now. Obsolete trees are listed only under History.

## Boundaries

Conversation Bot is a signed-in workspace for reconstructing project decisions from imported AI chats and files. One Grok Build project owns it.

- Project ID: `01a048b8-c1f7-7382-9dfd-fb30bff7137d`
- Production host: `https://cb-gptgrokclaud.grok.me`
- Source root: `src/`
- Framework: TypeScript, React 19, TanStack Start/Router, Vite, Nitro
- Auth: Better Auth via the Grok broker (Google, X, email/password)
- Data: Postgres (Neon in production, PGLite in preview), scoped by `user_id`
- Providers: NanoGPT (`sk-nano-…`) and OpenRouter (`sk-or-…`) as selectable API providers, plus OpenRusRouter for existing keys. One selected provider is frozen per Council run. Keys stay on the account row.

There is one production application and one production host. The Python tree `conversation-bot/` is SUPERSEDED and is not an implementation target.

## Major modules

See `docs/MODULE_REGISTRY.json` for IDs and status.

Control flow:

```text
UI (routes + council-ui)
→ account store (in-memory + persist RPCs)
→ task create (CREATE / REVIEW / DECIDE)
→ council.orchestrator (only path)
→ council.protocol (roles + synthesis schemas + gate)
→ council.providers (NanoGPT / OpenRouter)
→ Implementation Packet (when CREATE is APPROVED)
→ persist.postgres
```

Evidence flow:

```text
Selected chats and files
→ deterministic chunks
→ task-independent evidence extraction (cached by source hash + chunker + extractor)
→ evidence ledger (non-canonical)
→ task-aware ranked packer (6 000 token Council budget)
→ Council Round 1 / Round 2 / synthesis
```

Closed loop:

```text
Council CREATE APPROVED
→ Implementation Packet (scope, requirements, invariants, evidence refs, acceptance tests, blockers)
→ Build handoff JSON (direct Build execution unavailable)
→ recorded implementation result
→ Council REVIEW
→ PASS | PATCH | BLOCKED
```

## Persistence

Applied migrations (basename order):

1. `0001_auth.sql` — Better Auth identity
2. `0002_app.sql` — account_settings, projects, context, tasks, chats, history
3. `0003_task_modes.sql` — mode, manifests, artifacts
4. `0004_project_files.sql` — project_files, selected_file_ids
5. `0005_evidence_ledger.sql` — evidence_chunks, evidence_items, extractor_cache
6. `0006_closed_loop.sql` — council_results.review_verdict/structured, implementation_packets
7. `0007_provider_budget.sql` — `account_settings.nanogpt_key`, `tasks.provider` freeze
8. `0008_dynamic_council.sql` — `account_settings.selected_model_ids`, `synthesizer_model`, `model_catalog`; `tasks.selected_models`
9. `0009_provider_scan.sql` — `account_settings.last_test_log`, `last_test_at`, `last_test_ok`

`migrations/auth/` is a template copy. Appliers do not descend into subdirectories.

Authoritative rows are per signed-in `user_id`. Browser `localStorage` key `conversation-bot:v012` is a LEGACY one-shot import when the account snapshot is empty.

## Authentication

Canonical path: Better Auth session cookie (deployed) or bearer in preview → `authMiddleware` → `requireUserId`. Google and X go through `/api/oauth-start/$providerId` then `/api/auth/$`. Email/password uses the same session. Guest-gate (`auth-loop.ts`) caps auto-land hops so `/login` cannot bounce forever.

Do not add a second auth stack.

## Runtime shell

The boot, SSR/client boundary, auth bootstrap, Vite/Nitro config, and deploy entry are a protected shell (`docs/RUNTIME_SHELL.json`). Council, Evidence Ledger, and history patches must not change those files in the same commit. `npm run shell:gate` hashes the shell, rejects mixed product+shell diffs, forbids client `.server` imports, and requires a production build plus built-browser smoke before FUNCTIONALITY may be reported READY.

## Provider layer

Settings UI writes `account_settings`. Council server functions resolve the stored key for the signed-in user and the selected provider. Client never keeps the secret after save. Empty Save keeps the stored key; Clear Key wipes it. A Council run freezes exactly one provider (NanoGPT or OpenRouter) and the selected AVAILABLE models for Round 1, Round 2, synthesis, retries, and catalog/access preflight. NanoGPT and OpenRouter are API providers, never Council members. Switching provider re-runs discovery and drops stale selections. Membership and recommendations come only from models the current scan classified as AVAILABLE. Missing or inaccessible selected models fail with `MODEL_UNAVAILABLE` before paid calls and are never silently substituted. Hardcoded default IDs (including Grok 4.6) are never injected when absent from the scan. Test Connection always writes a sanitized persisted log. Catalog responses are normalized before any model logic (direct array or OpenAI `{ data: [...] }`); unsupported shapes fail with `CATALOG_PARSE_ERROR`. CONNECTED requires an authenticated provider check. A failed refresh never presents a previous scan as current — old catalogs are STALE cached data. USD cost is telemetry only. The hard execution gate is request attempts: expected successful calls = 2N+1, ceiling = 2N+1+N+2 (N=3 → 7 / 12). Empty completions are failures.

## Council workflow

Modes: CREATE, REVIEW, DECIDE. Preflight lives in `council.task-mode`. Execution lives only in `src/lib/council/orchestrate.ts` (`runCouncil`). Membership is 2–5 user-selected models discovered from the connected provider. Roles (LEAD_REASONER, ADVERSARIAL, FORMAL_REVIEW, RESEARCH, ALTERNATIVE_REASONER) are guidance, not vendor identities. Round 1 is independent. Round 2 is cross-examination. Synthesis is structured JSON from a selected surviving model (user override allowed, still must be selected). CREATE writes an artifact. REVIEW returns PASS / PATCH / BLOCKED and must not silently replace a candidate. DECIDE returns decision, alternatives, rationale, evidence, and risks. Unresolved DECIDE disagreement or CONFLICTED evidence becomes `USER_DECISION_REQUIRED`. Two of N models may complete a run; a single survivor fails the council. Catalog/access preflight blocks unavailable models before paid dispatch. Selected members are marked RUNNING as Round 1 starts. Stop aborts in-flight provider waits and marks `CANCELLED` with partial responses. Restart creates a new `run_id`, preserves the previous run for audit, and ignores late writes from the cancelled generation. A new run may switch provider; calls inside one run never mix providers.

Positions, disagreements, blockers, resolved/unresolved issues, and citations are preserved on the Council result.

## Context pipeline (current)

Every selected chat and file is chunked, then extracted into a non-canonical Evidence Ledger. Frozen invariants, decisions, specs, and project state are mandatory and packed first. If they exceed the 6 000 token Council budget (`countTokens`) the run fails with `CONTEXT_BUDGET_EXCEEDED` instead of slicing. Remaining budget is filled with ranked ledger claims. One selected source may use the full evidence budget; multiple sources get a diversity cap, then unused budget is redistributed deterministically. `HISTORY_NOT_CANONICAL` still holds: ledger rows never become DECISION / SPEC / INVARIANT. Coverage COMPLETE means every selected chunk was processed, not semantic recall. Previously truncated sources without recoverable raw data are `REIMPORT_REQUIRED`. Invalid or unpacked citations are demoted; they never mint canonical truth. ADR-006 is ACTIVE; ADR-005 first-N `boundContext` is superseded.

## Artifact lifecycle

CREATE synthesis → Artifact row + evidence labels. APPROVED CREATE also writes an Implementation Packet. Direct Build execution is unavailable; the packet JSON is the handoff. Recorded implementation results open a REVIEW task. PASS/BLOCKED close the packet. PATCH returns it to READY for another iteration. DECIDE records decision/rationale/alternatives/evidence/risks on the council result. Evaluation rows summarize mode, outcome, disagreements, evidence used, iterations, and later corrections.

## Deployment

`npm run build` (Vite + `db:migrate`) publishes through Grok Build to the same project ID / Vercel / `cb-gptgrokclaud.grok.me`.

## History (not current)

- Python FastAPI prototype in `conversation-bot/` — SUPERSEDED, unreachable from the TS app.
- Browser-only v0.12 store — LEGACY import adapter only.

Future patches must run `npm run arch:preflight` and declare `TARGET_ARCHITECTURE_REVISION` plus `TARGET_MODULES`.
