# Conversation Bot architecture

Current revision: **CB-ARCH-20260829-001**

This document describes the system that is running now. Obsolete trees are listed only under History.

## Boundaries

Conversation Bot is a signed-in workspace for reconstructing project decisions from imported AI chats and files. One Grok Build project owns it.

- Project ID: `01a048b8-c1f7-7382-9dfd-fb30bff7137d`
- Production host: `https://swift-lake-solar-cosmic.grok.me`
- Source root: `src/`
- Framework: TypeScript, React 19, TanStack Start/Router, Vite, Nitro
- Auth: Better Auth via the Grok broker (Google, X, email/password)
- Data: Postgres (Neon in production, PGLite in preview), scoped by `user_id`
- Providers: OpenRouter and OpenRusRouter, keys on the account row

There is one production application and one production host. The Python tree `conversation-bot/` is SUPERSEDED and is not an implementation target.

## Major modules

See `docs/MODULE_REGISTRY.json` for IDs and status.

Control flow:

```text
UI (routes + council-ui)
→ account store (in-memory + persist RPCs)
→ task create
→ council.orchestrator (only path)
→ council.protocol (context pack + roles + gate)
→ council.providers (OpenRouter / OpenRusRouter)
→ persist.postgres
```

Evidence flow:

```text
AI Chat Sources + Files + Memory (invariants/decisions/specs)
→ Context Manifest
→ buildContext concatenation
→ boundContext (24 000 characters)
→ Council Round 1 / Round 2 / synthesis
→ Artifact (CREATE) or review verdict
```

## Persistence

Applied migrations (basename order):

1. `0001_auth.sql` — Better Auth identity
2. `0002_app.sql` — account_settings, projects, context, tasks, chats, history
3. `0003_task_modes.sql` — mode, manifests, artifacts
4. `0004_project_files.sql` — project_files, selected_file_ids

`migrations/auth/` is a template copy. Appliers do not descend into subdirectories.

Authoritative rows are per signed-in `user_id`. Browser `localStorage` key `conversation-bot:v012` is a LEGACY one-shot import when the account snapshot is empty.

## Authentication

Canonical path: Better Auth session cookie (deployed) or bearer in preview → `authMiddleware` → `requireUserId`. Google and X go through `/api/oauth-start/$providerId` then `/api/auth/$`. Email/password uses the same session. Guest-gate (`auth-loop.ts`) caps auto-land hops so `/login` cannot bounce forever.

Do not add a second auth stack.

## Provider layer

Settings UI writes `account_settings`. Council server functions resolve the stored key for the signed-in user. Client never keeps the secret after save. Empty Save keeps the stored key; Clear Key wipes it.

## Council workflow

Modes: CREATE, REVIEW, DECIDE. Preflight lives in `council.task-mode`. Execution lives only in `src/lib/council/orchestrate.ts` (`runCouncil`). Round 1 is independent. Round 2 is cross-examination. Synthesis is JSON. CREATE writes an artifact. REVIEW must not silently replace one.

## Context pipeline (current)

Selected chats become `RAW_HISTORY`. Selected files are wrapped as untrusted. `buildContext` concatenates project, task, files, invariants, then history. `boundContext` slices to 24 000 characters (~6k tokens). That is the only packer in this revision. Hierarchical Evidence Ledger is **not** in this revision (ADR-006 PROPOSED).

## Artifact lifecycle

CREATE synthesis → Artifact row + evidence labels. REVIEW consumes a candidate. DECIDE records decision/rationale/dissent on the council result.

## Deployment

`npm run build` (Vite + `db:migrate`) publishes through Grok Build to the same project ID / Vercel / `swift-lake-solar-cosmic.grok.me`.

## History (not current)

- Python FastAPI prototype in `conversation-bot/` — SUPERSEDED, unreachable from the TS app.
- Browser-only v0.12 store — LEGACY import adapter only.

Future patches must run `npm run arch:preflight` and declare `TARGET_ARCHITECTURE_REVISION` plus `TARGET_MODULES`.
