#!/usr/bin/env bash
# One-command setup. Run once:  curl -fsSL <raw-url>/bootstrap.sh | bash
# Installs node+pm2, clones the repo, asks for your secrets, starts the bot (PAPER) + auto-updater.
set -e
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
BR="claude/catboy-website-nspovy"; DIR="$HOME/catboy"
echo "== catboy autocopy bootstrap =="
if ! command -v node >/dev/null 2>&1; then echo "[*] installing node 20..."; curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null; $SUDO apt-get install -y nodejs >/dev/null; fi
command -v pm2 >/dev/null 2>&1 || { echo "[*] installing pm2..."; $SUDO npm install -g pm2 >/dev/null; }
if [ -d "$DIR/.git" ]; then cd "$DIR"; git fetch origin "$BR" -q; git checkout "$BR" -q; git reset --hard "origin/$BR" -q; else echo "[*] cloning..."; git clone -b "$BR" https://github.com/PettyMiggzy/catboy.git "$DIR" -q; cd "$DIR"; fi
echo "[*] installing deps..."; npm install --no-audit --no-fund --silent
ENVF="autocopy/deploy/.env"
if [ ! -f "$ENVF" ]; then
  echo ""; echo "== paste your secrets (they stay only on this server) =="
  read -rp "BOT_TOKEN: " BT
  read -rsp "PRIVATE_KEY (burner, hidden): " PK; echo ""
  read -rp "RPC_URL (alchemy https): " RU
  read -rp "RPC_WSS (alchemy wss, or blank): " RW
  { echo "BOT_TOKEN=$BT"; echo "CHAT_ID=6820752140"; echo "PRIVATE_KEY=$PK"; echo "RPC_URL=$RU"; echo "RPC_WSS=$RW"; echo "DRY_RUN=1"; echo "COPY_ETH=0.004"; } > "$ENVF"
  chmod 600 "$ENVF"; echo "[*] secrets saved (DRY_RUN=1 / paper)"
fi
pm2 delete autocopy autocopy-deploy >/dev/null 2>&1 || true
pm2 start autocopy/deploy/ecosystem.config.cjs
pm2 save >/dev/null
echo ""; echo "✅ RUNNING IN PAPER MODE. It self-updates from now on."
echo "   watch:  pm2 logs autocopy   |   go live later: set DRY_RUN=0 in $DIR/$ENVF then: pm2 restart autocopy"
$SUDO env PATH=$PATH pm2 startup systemd -u $(whoami) --hp $HOME >/dev/null 2>&1 || pm2 startup >/dev/null 2>&1 || true
