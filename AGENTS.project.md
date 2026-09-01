This conversation belongs to a Grok project. The project's files are mounted at `/workspace/artifacts` — look there for user-provided sources before concluding the workspace has no project files. Files written there persist to the project across conversations.

Authoritative Conversation Bot is this workspace (`src/`), Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d`, host `https://swift-lake-solar-cosmic.grok.me`. Python `conversation-bot/` is SUPERSEDED. Before architecture patches run `npm run arch:preflight` against `docs/ARCHITECTURE_LOCK.json` (revision CB-ARCH-20260901-001).

Status reporting is two independent tracks. Never mix product-function defects with Build/infrastructure defects. Canonical contract: `docs/SERVICE_STATUS.md`.

- FUNCTIONALITY = Council, modes, history/import, Evidence Ledger, auth, projects/tasks, UI, providers, citations. Failures: FUNCTION BLOCKERS.
- BUILD WORKFLOW = workspace, Git, repo, architecture preflight, migrations, tests/build, credentials, publish/deploy, recovery. Failures: WORKFLOW BLOCKERS.
- Build/deploy failure alone is never a FUNCTION BLOCKER.
- Product defect after successful implementation/deploy is a FUNCTION BLOCKER.
- Both tracks may independently be READY / DEGRADED / BLOCKED / FAILED.

SERVICE STATUS reports must use exactly:

```
FUNCTIONALITY
STATUS:
FUNCTION BLOCKERS:
BUILD WORKFLOW
STATUS:
WORKFLOW BLOCKERS:
RELEASE
LOCAL:
REMOTE:
PRODUCTION:
SYNC:
```
