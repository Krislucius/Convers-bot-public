# Git workflow — Conversation Bot

Remote: `origin` = `https://github.com/Krislucius/Convers-bot-public.git`  
Branch: `main`  
Editable source: `/workspace` (Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d`)  
Production host: https://swift-lake-solar-cosmic.grok.me  
Architecture: `CB-ARCH-20260901-002`  
Current release: `CB-BUILD-20260902-007`  
Freeze tag: `CB-BUILD-20260830-003` → `b5dc720e2a99c97b8b003df3e02e6d6b83f358db`

Deployed identity is `BUILD_ID` (the git release tag). `SOURCE_COMMIT` is optional diagnostic metadata; `UNKNOWN` does not degrade health. `PROD_SYNC` is production `BUILD_ID` matching the git release tag.

GitHub is the durable remote and preferred recovery source once `main` has been pushed from `/workspace`.  
`artifacts/` and ZIP archives are fallback backups only.

Git tags, hashes and architecture metadata are audit aids, not development locks. Current code may be patched, refactored and deployed normally.

Git, repo, preflight, tests/build, credentials, publish/deploy, and recovery belong to **BUILD WORKFLOW**. They never become FUNCTION BLOCKERS. Product defects after a successful deploy are FUNCTION BLOCKERS. Canonical split: [docs/SERVICE_STATUS.md](SERVICE_STATUS.md).

## Session start

```bash
cd /workspace
git fetch origin
```

Work from the current `/workspace`. Reconcile remote changes before overlapping edits.

## After validated changes

test → commit → push

```bash
cd /workspace
npm test
git add -A
git status
git commit -m "…"
git push origin main
```

Do not force-push `main` over unrelated remote history. Never commit `.env`, private keys, or live API credentials.

## Recover if `/workspace` is lost

```bash
git clone https://github.com/Krislucius/Convers-bot-public.git
```

Use `origin/main` as the recovery source. Do not reconstruct from `artifacts/` or a ZIP unless the remote is empty or unreachable.

## Local identity and hooks

```
user.name  Kris
user.email kris@conversation-bot.local
```

After a fresh clone:

```
git config core.hooksPath .githooks
```

| Hook | Guard |
|---|---|
| `pre-commit` | Blocks `.env`, private keys, live-looking `sk-or-v1-` / `orr_live_` keys outside placeholder files |
| `pre-push` | Runs `npm run arch:preflight` |

GitHub is not production. Product patches still follow: edit this tree → tests → build → deploy the **same** Grok Build project id.
