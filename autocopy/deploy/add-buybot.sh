#!/usr/bin/env bash
# One-shot: add the HoodX buy bot to this droplet and start it under pm2.
# Run in the DigitalOcean console:  bash ~/catboy/autocopy/deploy/add-buybot.sh
# It only asks for the secret bot token; the public config is filled in for you.
set -e
cd "$(dirname "$0")/../.." || exit 1
ENV="autocopy/deploy/.env"
touch "$ENV"; chmod 600 "$ENV"

# public, non-secret config — safe to hardcode (wallet addresses + channel id are public)
add() { grep -q "^$1=" "$ENV" || printf '%s=%s\n' "$1" "$2" >> "$ENV"; }
add TRENDING_CHANNEL "-1004414481505"
add TRENDING_ON "1"
add TREND_EVM_WALLET "0x7b4102ec23836aef2e6edb60ce2d2d4ee1aba63c"
add TREND_SOL_WALLET "5ovSyAjJR3zWi1FFLfuidQThSDA2A7UuqhHpPJhiJbbk"

# secret bot token — prompt (never stored in git)
if ! grep -q "^TG_BOT_TOKEN=" "$ENV"; then
  echo ""
  read -rp "Paste the buy-bot Telegram token, then press Enter: " TG
  [ -z "$TG" ] && { echo "no token entered — aborting"; exit 1; }
  printf 'TG_BOT_TOKEN=%s\n' "$TG" >> "$ENV"
fi

# optional Alchemy backup RPC (bot runs fine on the free RPCs without it)
if ! grep -q "^ALCHEMY_HTTP=" "$ENV"; then
  read -rp "Paste Alchemy HTTPS URL (optional — press Enter to skip): " AH
  [ -n "$AH" ] && printf 'ALCHEMY_HTTP=%s\n' "$AH" >> "$ENV"
fi

pm2 start autocopy/deploy/ecosystem.config.cjs --only buybot --update-env
pm2 save
echo ""
echo "=== buybot started — recent logs (should say 'Buy Bot running') ==="
pm2 logs buybot --lines 20 --nostream
