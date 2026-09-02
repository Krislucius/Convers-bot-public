# Conversation Bot

Grok Build project `01a048b8-c1f7-7382-9dfd-fb30bff7137d`  
Architecture `CB-ARCH-20260901-002` · Build `CB-BUILD-20260902-012`  
Production: https://swift-lake-solar-cosmic.grok.me

Source root: `src/` (TanStack Start / React 19). Python `conversation-bot/` is superseded.

Status reporting: functionality vs build workflow are independent tracks. See [docs/SERVICE_STATUS.md](docs/SERVICE_STATUS.md).

## Setup

```bash
cp .env.example .env
# fill DATABASE_URL, BETTER_AUTH_*, GROK_AUTH_*
npm ci
git config core.hooksPath .githooks
npm test
npm run typecheck
npm run build
```

Preview in this Grok Build project listens on the sandbox contract port via `npm run dev`.

Git: `main` → `origin` `https://github.com/Krislucius/Convers-bot-public.git`. Release tag `CB-BUILD-20260902-012`. See [docs/GIT.md](docs/GIT.md).

Do not create a second Grok app or a second `*.grok.me` host.
