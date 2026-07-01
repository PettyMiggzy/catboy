#!/usr/bin/env bash
# One-shot: create the Spaces bucket, enable its CDN, and deploy the App Platform app.
# Run this LOCALLY. Your secret + DO token stay on your machine — never in chat/repo.
#
# Prereqs: aws CLI (brew install awscli) and doctl (brew install doctl; doctl auth init).
# Set these in your terminal first (paste your real values):
#   export SPACES_KEY=DO00HWBAPTKWG26H9WRJ
#   export SPACES_SECRET=xxxxxxxx           # the secret half (keep private)
#   export DO_API_TOKEN=dop_v1_xxxxxxxx     # DO panel -> API -> Generate Token (read+write)
#   export VENICE_KEY=your-venice-key
set -euo pipefail
: "${SPACES_KEY:?set SPACES_KEY}"; : "${SPACES_SECRET:?set SPACES_SECRET}"
: "${DO_API_TOKEN:?set DO_API_TOKEN}"; : "${VENICE_KEY:?set VENICE_KEY}"
REGION="${REGION:-nyc3}"; BUCKET="${BUCKET:-catboy-assets}"
ADMIN_TOKEN="${ADMIN_TOKEN:-$(openssl rand -hex 24)}"
EP="https://$REGION.digitaloceanspaces.com"

echo "==> 1. Create Space bucket ($BUCKET, $REGION)"
AWS_ACCESS_KEY_ID="$SPACES_KEY" AWS_SECRET_ACCESS_KEY="$SPACES_SECRET" \
  aws --endpoint-url "$EP" s3 mb "s3://$BUCKET" 2>/dev/null || echo "   (already exists — ok)"

echo "==> 2. Enable the Spaces CDN"
curl -sS -X POST "https://api.digitalocean.com/v2/cdn/endpoints" \
  -H "Authorization: Bearer $DO_API_TOKEN" -H "Content-Type: application/json" \
  -d "{\"origin\":\"$BUCKET.$REGION.digitaloceanspaces.com\",\"ttl\":3600}" | head -c 400; echo

echo "==> 3. Deploy backend on App Platform (auto-deploys on push after this)"
doctl apps create --spec .do/app.yaml --wait --format ID,DefaultIngress || {
  echo "   doctl create failed — create it in the panel from .do/app.yaml instead."; }

cat <<NOTE

==> DONE. Now set the app's SECRET env vars in the DO panel
    (Apps -> catboy-backend -> Settings -> App-Level Env Vars):
      VENICE_KEY     = $VENICE_KEY
      ADMIN_TOKEN    = $ADMIN_TOKEN     <-- SAVE THIS, you'll give it to Claude
      SPACES_KEY     = $SPACES_KEY
      SPACES_SECRET  = (your secret)
    Then test:  curl https://<app-url>/health
NOTE
