# Access to Conversation Bot /workspace

Recorded 2026-08-30. This file is an access map, not an implementation.

## Authoritative tree

- Grok Build project: `01a048b8-c1f7-7382-9dfd-fb30bff7137d`
- Production host: https://swift-lake-solar-cosmic.grok.me
- Architecture: `CB-ARCH-20260829-001`
- Build: `CB-BUILD-20260830-003`
- Live sandbox path (Grok Build sessions only): `/workspace`
- Source root: `/workspace/src`

`/workspace` exists only inside a Grok Build session of this project. Ordinary Grok chats do not mount it.

## Git

Local repository on `/workspace`:

- Branch: `main`
- Freeze tag: `CB-BUILD-20260830-003`
- Hooks: `.githooks/` (`core.hooksPath`)
- Contract: `docs/GIT.md`
- Remote: **none** (GitHub not authorized)

This is a freeze record of the same tree. It is not a second app.

## What persists across chats

Grok project chats mount `/workspace/artifacts` (sometimes `/home/workdir/artifacts`).

Durable copies in this folder:

| Path | Role |
|---|---|
| `artifacts/conversation-bot-CB-BUILD-20260830-003.zip` | Portable archive |
| `artifacts/workspace-source/` | Unpacked source, same revision |
| `artifacts/ACCESS.md` | This map |

SHA256 of the zip:

`a00f0206e0c8e082141ad92d04a38f307d3669910365223c1b86bcc201a14bb5`

These copies are for access and export. They are **not** a second app and **not** the place to edit product code. Edits belong in `/workspace` of this Build project, then tests → build → same-project deploy.

## How to open the live /workspace

1. Open this Grok Build project (same project id).
2. Work in that Build chat. `/workspace` is then mounted.
3. Do not start Remix / a second `*.grok.me` host / a Python replacement.

## How to use the source outside Grok

Unpack the zip, copy `.env.example` → `.env`, set Neon + Better Auth + broker values, then `npm ci`.

Python tree `conversation-bot/` in the Build sandbox is SUPERSEDED and is not in the export.

## Not available

- SSH / SFTP into the sandbox
- Git remote / GitHub repository (local Git only)
- Operator shell on `/workspace`
