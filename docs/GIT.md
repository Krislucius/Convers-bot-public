# Git contract — Conversation Bot

Local Git is the freeze record for this tree. It is **not** a second app and
**not** a production host.

| Item | Value |
|---|---|
| Project | `01a048b8-c1f7-7382-9dfd-fb30bff7137d` |
| Host | https://swift-lake-solar-cosmic.grok.me |
| Architecture | `CB-ARCH-20260829-001` |
| Freeze build | `CB-BUILD-20260830-003` |
| Freeze tag | `CB-BUILD-20260830-003` |
| Default branch | `main` |
| Remote | **none** (not authorized) |

## What is in the repository

Tracked: `src/`, `public/`, `migrations/`, `scripts/`, `server/`, `docs/`,
`package.json`, lockfile, Vite/Nitro config, `.env.example`, architecture lock,
module registry, ADRs, `.githooks/`.

Never tracked: `.env`, secrets, `node_modules/`, `.vercel/`, `.tanstack/`,
Python `conversation-bot/`, zip exports, Grok skill packs, screenshots.

## Local identity

```
user.name  Kris
user.email kris@conversation-bot.local
```

Replace the email only if you want commits attributed to a real address. Do not
put live secrets in git config.

After a fresh clone:

```
git config core.hooksPath .githooks
```

This sandbox already has that config.

## Hooks

| Hook | Guard |
|---|---|
| `pre-commit` | Blocks `.env`, private keys, live-looking `sk-or-v1-` / `orr_live_` keys outside placeholder files |
| `pre-push` | Runs `npm run arch:preflight` |

Hooks live in `.githooks/` so they are versioned. Git does not use them until
`core.hooksPath` points there.

## Remote / GitHub

No `origin`. `gh` is not logged in. A GitHub repository is **not** created
unless the operator explicitly authorizes one (name, visibility, org).

If authorized later, the expected shape is a **private** repo, single remote
`origin`, branch `main`, no force-push of `CB-BUILD-20260830-003`.

Do not:

- create a second Grok Build project
- publish a second `*.grok.me` host
- treat a GitHub clone as production

## Operator commands

```
git status
git log --oneline -5
git show CB-BUILD-20260830-003 --stat
npm run arch:preflight
```

Product patches still follow: edit this tree → tests → build → deploy the
**same** Grok Build project id. Git records the source; it does not replace
deploy.
