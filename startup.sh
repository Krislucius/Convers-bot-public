#!/bin/sh
# Revive contract: start the app on 0.0.0.0:8080.
set -eu
cd /workspace
export PATH="${HOME}/.local/bin:/usr/local/bin:${PATH}"

node scripts/preview.mjs stop || true
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
