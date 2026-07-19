#!/usr/bin/env bash
# Auto-deploy: every INTERVAL, pull the latest bot code and restart on change.
# Run under pm2 (see ecosystem.config.cjs). After the one-time setup, ALL updates flow through here.
set -u
cd "$(dirname "$0")/../.." || exit 1                 # repo root
BRANCH="${DEPLOY_BRANCH:-claude/catboy-website-nspovy}"
INTERVAL="${DEPLOY_INTERVAL:-60}"
git config --global --add safe.directory "$(pwd)" 2>/dev/null || true
echo "[deploy] watching origin/$BRANCH every ${INTERVAL}s"
while true; do
  git fetch origin "$BRANCH" --quiet 2>/dev/null || { sleep "$INTERVAL"; continue; }
  LOCAL=$(git rev-parse HEAD 2>/dev/null)
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)
  if [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
    echo "[deploy] $LOCAL -> $REMOTE, updating"
    git reset --hard "origin/$BRANCH" --quiet
    if git diff --name-only "$LOCAL" "$REMOTE" | grep -qE 'package(-lock)?\.json'; then
      echo "[deploy] deps changed, npm install"; npm install --no-audit --no-fund --silent
    fi
    pm2 restart autocopy --update-env >/dev/null 2>&1 && echo "[deploy] restarted autocopy @ $REMOTE"
  fi
  sleep "$INTERVAL"
done
