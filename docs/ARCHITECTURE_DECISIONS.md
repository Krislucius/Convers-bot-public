# Architecture decision register

Only ACTIVE rows define current architecture.

## ADR-001

- DECISION: Production Conversation Bot is the TypeScript / TanStack Start app in this Grok Build project.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: One project, one host, one source tree.
- SUPERSEDES: Python FastAPI prototype
- AFFECTED_MODULES: app.shell, legacy.python-fastapi

## ADR-002

- DECISION: Authentication is Better Auth via the Grok broker (Google, X, email). Auth stays ON.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Per-account projects, chats, files, and keys.
- SUPERSEDES: none
- AFFECTED_MODULES: auth.session, auth.loop-breaker

## ADR-003

- DECISION: Durable state lives in Postgres scoped by verified `user_id`.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Preview and production share the same schema via migrations.
- SUPERSEDES: browser-only v0.12 store as authority
- AFFECTED_MODULES: persist.postgres, account.persistence, legacy.localStorage-v012

## ADR-004

- DECISION: CREATE, REVIEW, and DECIDE share one orchestrator (`runCouncil`).
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Mode-specific preflight and synthesis, no second Council path.
- SUPERSEDES: none
- AFFECTED_MODULES: council.orchestrator, council.task-mode, council.protocol

## ADR-005

- DECISION: Current context packer is `buildContext` concatenation plus `boundContext` at 24 000 characters.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: This is the implemented packer. Cost estimates and Council prompts use it. Changing it is an architecture revision, not a silent patch.
- SUPERSEDES: none
- AFFECTED_MODULES: context.pipeline, council.protocol

## ADR-006

- DECISION: Hierarchical Evidence Ledger (chunk → extract → ledger → council pack) is proposed, not implemented.
- STATUS: PROPOSED
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Product request exists; this hardening revision does not change Council context semantics.
- SUPERSEDES: none
- AFFECTED_MODULES: context.evidence-ledger, context.pipeline

## ADR-007

- DECISION: Every future patch must pass architecture preflight against `docs/ARCHITECTURE_LOCK.json`.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Prevent stale-module and parallel-app patches.
- SUPERSEDES: none
- AFFECTED_MODULES: architecture.lock
