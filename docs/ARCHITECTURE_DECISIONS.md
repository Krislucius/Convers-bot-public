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
- STATUS: SUPERSEDED
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: First-N character slice silently dropped later selected sources. Replaced by the Evidence Ledger packer.
- SUPERSEDES: none
- SUPERSEDED_BY: ADR-006
- AFFECTED_MODULES: context.pipeline, council.protocol

## ADR-006

- DECISION: Canonical Council context is Evidence Ledger packing: RAW sources → chunks → task-independent extraction → ledger → task-aware ranked packer within a 6 000 token budget (`countTokens`). COMPLETE coverage means every selected chunk was processed, not guaranteed semantic recall. A single selected source may use the full evidence budget; multiple sources use a diversity cap with deterministic leftover redistribution.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260901-001
- RATIONALE: Process every selected source. Mandatory canonical context has priority. Ledger evidence stays non-canonical. Coverage must be explicit.
- SUPERSEDES: ADR-005
- AFFECTED_MODULES: context.evidence-ledger, context.pipeline, council.orchestrator, council.manifest

## ADR-007

- DECISION: Every future patch must pass architecture preflight against `docs/ARCHITECTURE_LOCK.json`.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260829-001
- RATIONALE: Prevent stale-module and parallel-app patches.
- SUPERSEDES: none
- AFFECTED_MODULES: architecture.lock

## ADR-008

- DECISION: Council closed loop is CREATE / REVIEW / DECIDE structured synthesis → Implementation Packet (scope, requirements, invariants, evidence refs, acceptance tests, blockers) → Build handoff JSON → recorded implementation result → Council REVIEW with PASS / PATCH / BLOCKED. Direct Build execution is unavailable; the packet is first-class state, never a simulated run. One of three Council models may fail if two survive. Invalid or unpacked citations are demoted and never mint canonical truth.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260901-002
- RATIONALE: Artifact approval without a reviewable implementation packet and verdict leaves the decision loop open.
- SUPERSEDES: none
- AFFECTED_MODULES: council.packet, council.evaluate, council.review, council.orchestrator, council.protocol, account.persistence

## ADR-009

- DECISION: Each Council run uses exactly one selected API provider (NanoGPT or OpenRouter) for GPT, Grok, Claude, synthesis, retries, and catalog preflight. Provider selection persists on the task. Missing models fail with `MODEL_UNAVAILABLE_ON_PROVIDER` before paid calls. USD cost is telemetry only. The hard execution gate is 12 provider attempts per run (7 expected successful calls; max 3 attempts per agent/stage; retries count; completed calls are not repeated). Empty completions are failures.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260904-003
- RATIONALE: Mixing aggregators inside a run made retries and cost accounting untrustworthy. A USD estimate gate stopped synthesis after successful rounds. Request counts are the recoverable safety limit.
- SUPERSEDES: NanoGPT-only Connect API default from CB-BUILD-20260904-025
- AFFECTED_MODULES: council.providers, council.orchestrator, council.protocol, account.persistence, ui.settings

## ADR-010

- DECISION: Council membership is provider-discovered and user-selected (2–5 models). Roles (LEAD_REASONER, ADVERSARIAL, FORMAL_REVIEW, RESEARCH, ALTERNATIVE_REASONER) are guidance, not vendor identities. Test Connection fetches the catalog and probes actual account access; catalog presence is not usable access. Unavailable or not-included selected models block a paid run with `MODEL_UNAVAILABLE` and are never silently substituted. Synthesis uses only a selected surviving model. Expected successful calls = 2N+1; attempt ceiling = 2N+1+N+2. Switching provider re-runs discovery and never mixes providers inside one run. USD remains telemetry.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260905-001
- RATIONALE: Fixed GPT/Grok/Claude membership forced unavailable models and mixed vendor identity with review duty. Account access must be verified, not inferred from a catalog listing.
- SUPERSEDES: fixed GPT/Grok/Claude membership implied by ADR-009
- AFFECTED_MODULES: council.providers, council.orchestrator, council.protocol, council.discovery, account.persistence, ui.settings

## ADR-011

- DECISION: NanoGPT and OpenRouter are API providers, never Council models. Council membership and recommendations are computed only from models the current provider scan classified as AVAILABLE after catalog fetch and access probe. Hardcoded or default model IDs (including Grok 4.6) are never injected when they are absent from the scan. Stale selected IDs are dropped when the provider or catalog changes. Test Connection always generates and persists a sanitized log, including successful connections, and never includes API secrets.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260905-002
- RATIONALE: Treating aggregator brand names as models and injecting default IDs caused missing models such as Grok 4.6 to appear in recommendations and Council membership.
- SUPERSEDES: none (tightens ADR-010)
- AFFECTED_MODULES: council.discovery, council.orchestrator, account.persistence, ui.settings

## ADR-012

- DECISION: Provider catalog responses are normalized before any model mapping. Supported shapes are a direct array of models and an OpenAI-compatible `{ data: [...] }` payload. Unsupported shapes fail with `CATALOG_PARSE_ERROR` and sanitized shape metadata in the Test Log. Test Connection is one atomic attempt: current Status, Models discovered, Models available, and Test Log belong to that attempt. A failed refresh never displays a previous scan (including 616/6) as current; the previous catalog is STALE cached data only. CONNECTED is reported only after an authenticated provider check succeeds (catalog HTTP 2xx + successful normalize + no probe 401). NanoGPT remains a provider, never a model. Test logs always persist for PASS and FAIL and never include the API secret.
- STATUS: ACTIVE
- ARCHITECTURE_REVISION: CB-ARCH-20260905-003
- RATIONALE: Unnormalized catalog objects were treated as empty success, and a failed Test Connection reused previous discovered/available counts as current status.
- SUPERSEDES: none (tightens ADR-011)
- AFFECTED_MODULES: council.discovery, ui.settings
