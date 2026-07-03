#!/usr/bin/env bash
# Fast poller for a droplet. Loads .env, runs the scan every $POLL seconds.
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a
POLL="${POLL:-25}"
echo "[watcher] loop started — polling every ${POLL}s"
while true; do
  python3 scan.py || echo "[watcher] scan error (continuing)"
  sleep "$POLL"
done
