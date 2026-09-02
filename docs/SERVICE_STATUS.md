# Service status — two independent tracks

Conversation Bot reports **functionality** and **build workflow** separately.
Never mix them. A build/deploy failure is not a product defect. A product
defect is not a workflow failure.

Tracks may independently be `READY` / `DEGRADED` / `BLOCKED` / `FAILED`.

## Tracks

### 1. FUNCTIONALITY

The Conversation Bot product:

Council, CREATE/REVIEW/DECIDE, history/import, Evidence Ledger, Implementation Packet, evaluation, auth,
projects/tasks, UI, providers, citations.

Failures on this track are **FUNCTION BLOCKERS**.

### 2. BUILD WORKFLOW

Execution infrastructure:

workspace, Git, repo, architecture preflight, migrations, tests/build,
credentials, publish/deploy, recovery.

Failures on this track are **WORKFLOW BLOCKERS**.

## Classification rules

- Build/deploy failure alone is never a FUNCTION BLOCKER.
- Product defect after successful implementation/deploy is a FUNCTION BLOCKER.
- Unpublished or stale production is WORKFLOW (RELEASE/SYNC), never FUNCTION.
- `SOURCE_COMMIT=UNKNOWN` is diagnostic, not a blocker on either track.
- Designed product gates (`REIMPORT_REQUIRED`, coverage incomplete, cost cap)
  are functionality constraints, not workflow failures. They are FUNCTION
  BLOCKERS only if the gate itself is wrong or the recovery path is broken.
- GitHub is not production. Remote `main` matching local is not `PROD_SYNC`.
- Local preview PGLite/wasm/Vercel-output issues are WORKFLOW. Production Neon
  is a different runtime.

If a signed-in user would see a wrong Council/auth/ledger result on a correctly
deployed build → FUNCTION. If the agent cannot implement, test, commit, push,
publish, or recover → WORKFLOW.

## Production FUNCTIONALITY readiness

Production FUNCTIONALITY may be **READY only after a real browser smoke
reaches an interactive UI state**.

HTTP 200, healthy bundles, readable release identity, and auth-health endpoints
are **necessary but not sufficient**.

Required browser smoke (guest, and authenticated when a session exists):

- guest cold load
- reload
- login screen becomes interactive
- authenticated bootstrap resolves when a session exists
- no infinite loading / watchdog overlay (“The app did not finish loading”)
- no uncaught browser console errors
- no blocking failed network requests
- route hydration completes
- primary UI controls are clickable

Classification:

- Server/routes/chunks healthy but browser UI does not become interactive →
  FUNCTIONALITY = `FAILED` or `DEGRADED`
  FUNCTION BLOCKER = `CLIENT_HYDRATION_OR_BOOTSTRAP_FAILURE`
- BUILD WORKFLOW may still be `READY` if deploy and `PROD_SYNC` succeeded.

Never report production FUNCTIONALITY READY from HTTP/chunk checks alone.

## Runtime shell

The protected runtime shell is listed in `docs/RUNTIME_SHELL.json` (root routing, SSR/client boundary, auth bootstrap, Vite/Nitro, production entry, deploy config).

`npm run shell:gate` is the release gate:

- production build
- built-browser cold load, reload, interactive login
- authenticated bootstrap terminates
- no hydration / watchdog overlay
- no client import of `.server` modules
- functional (Council/evidence/history) patches that also touch shell files fail (`SHELL_SCOPE_VIOLATION`)

Shell-gate and publish/deploy failures are **WORKFLOW BLOCKERS**. A deployed build whose browser UI is not interactive is a **FUNCTION BLOCKER**.

## Required SERVICE STATUS format

Copy this shape. Do not merge the blocker lists. Do not omit a track because
the other is failing.

```
FUNCTIONALITY
STATUS:
BROWSER_SMOKE:
HYDRATION:
AUTH_BOOTSTRAP:
CONSOLE_ERRORS:
FUNCTION BLOCKERS:

BUILD WORKFLOW
STATUS:
PRODUCTION_BUILD:
PROD_SYNC:
WORKFLOW BLOCKERS:

RELEASE
LOCAL:
REMOTE:
PRODUCTION:
SYNC:
```

`STATUS` is one of `READY`, `DEGRADED`, `BLOCKED`, `FAILED`.

`RELEASE` is identity, not a third blocker track:

- `LOCAL` — `/workspace` `BUILD_ID` + commit
- `REMOTE` — `origin/main` `BUILD_ID` + commit
- `PRODUCTION` — deployed `BUILD_ID` on https://swift-lake-solar-cosmic.grok.me
- `SYNC` — `PROD_SYNC` when production `BUILD_ID` equals the git release tag

## EXECUTION reports

EXECUTION returns whatever sections the operator asked for. Blockers in those
reports still follow this split: product defects under FUNCTION BLOCKERS,
infrastructure under WORKFLOW BLOCKERS. Do not put publish/git/preflight/test
harness failures in a FUNCTION list.
