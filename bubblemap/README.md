# RH Bubble Maps

Bubble maps for **Robinhood Chain** (chainId 4663). Wallet holder graphs: bubbles sized by
% of supply, edges = transfers, clusters expose same-block buyers and common funders.

**Free-first:** everything runs on the public RPC + Blockscout ($0). Alchemy is optional
fallback for rate-limit relief and native-funding cluster data.

## Quick start
```bash
cp .env.example .env
node scripts/index-token.mjs 0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49   # $STAG
# writes data/stag-graph.json → open public/bubblemap.html
```

## Deploy
Standalone Vercel project (Node functions in `api/`, static `public/`). Set a **separate**
`BUBBLE_DATABASE_URL` (Neon) — do not reuse another app's database. See `HANDOFF.md` for the full plan.
