# Catboy NFT — Launch Runbook (our own mint, Metaplex Core)

Everything creative is done: 100 images (`assets/nft/collection/*.jpg`) + Metaplex
metadata (`assets/nft/collection/metadata/*.json`) + a live mint UI (`mint.html`).

Minting runs through **our own** serverless endpoint `api/mint.js` (no launchpad):

- Buyer pays the pack price → the server **verifies the payment on-chain** → it
  **rolls a rarity by that pack's odds** → mints a **Metaplex Core** NFT straight
  to the buyer. Cheap (~0.0029 SOL rent/NFT, only when it sells), payment can't be
  bypassed, and the tiered packs get **real** different odds.

## What you need
- A **dedicated mint wallet** (`solana-keygen new -o mint-wallet.json`). Fund it
  with ~**1 SOL** (covers ~300 mints; top up from sales). It's the mint authority
  and where buyers pay.
- The repo's Neon DB (`DATABASE_URL`) and RPC (`SOLANA_RPC`) — already used by the site.

> ⚠️ **Test on devnet first.** The scripts default to devnet. Only switch to
> mainnet once a full mint works end-to-end.

## 1. Install + create the collection
```bash
npm install
# DEVNET first (airdrop: `solana airdrop 2 <addr> --url devnet`)
RPC="https://api.devnet.solana.com" \
KEYPAIR=./mint-wallet.json \
CREATOR_WALLET=<your royalty payout wallet> \
ROYALTY_PCT=5 \
node scripts/create-collection.mjs
```
It prints `NFT_COLLECTION=<address>` — save it.

## 2. Seed the inventory (from the manifest)
```bash
DATABASE_URL="<neon url>" BASE_URL="https://www.catboyonsol.fun" \
node scripts/seed-inventory.mjs
# -> seeded 100 items  tiers: Legendary:3 Epic:12 Rare:25 Common:60
```

## 3. Set Vercel env vars
| var | value |
|---|---|
| `NFT_MINT_WALLET` | the mint wallet's **public** address (buyers pay here) |
| `NFT_COLLECTION` | the address from step 1 |
| `NFT_MINT_SECRET` | the **contents of `mint-wallet.json`** (the `[..]` array) |
| `SOLANA_RPC` | your RPC url (already set) |
| `DATABASE_URL` | Neon url (already set) |

(`NFT_MINT_SECRET` is a hot key — keep it only in Vercel env, never in the repo.
It's a dedicated low-value wallet, so worst case is capped.)

## 4. Test the whole flow on devnet
Point a wallet at devnet, open `mint.html`, buy a pack, confirm you receive the
NFT and it shows in your wallet. `GET /api/mint` should show the counts dropping.

## 5. Go live on mainnet
- Re-run step 1 with `RPC=<mainnet rpc>` (new collection on mainnet) and update
  `NFT_COLLECTION`. Fund the mint wallet with real SOL.
- Flip `enabled: true` in `assets/mint-config.js`, commit + push.

## Pricing / odds
Authoritative in **`api/mint.js`** (`PACKS`). The values in `assets/mint-config.js`
are display only — keep them in sync. Current: Alley 0.05 / Nine Lives 0.2 / Alpha
0.6 SOL, with rarity odds per pack.

## Notes
- **Idempotent:** a retry or double-click with the same payment never double-mints
  or double-charges — the API resumes/returns the same NFT (keyed on the tx signature).
- **Pick-exact** (buy a specific #) isn't supported (random by design). To add it
  later we'd list minted pieces on a marketplace or add a per-item buy path.
- Royalties (default 5%) are set on the collection at creation → enforced on
  Magic Eden / Tensor secondary sales, paid to `CREATOR_WALLET`.
