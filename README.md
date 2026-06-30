# CATBOY — The Legend Crosses to Solana

Landing site for **$CATBOY**, the original anime meme legend reborn on Solana.

> BNB was the origin story. Solana is where the legend grows.

## Tech

Pure static site — no build step, no dependencies. Just HTML, CSS, and vanilla JS.

```
index.html    — page structure & copy
styles.css    — neon-purple/cyan cyberpunk theme
script.js     — config (contract + socials), copy button, scroll reveal
assets/
  catboy.png  — logo / hero image (PLACEHOLDER — replace with your art)
```

## Before launch — what to update

Everything you need to change lives at the top of `script.js`:

```js
const CONFIG = {
  contractAddress: "",          // Solana mint address at launch
  socials: {
    x: "https://x.com/...",     // your X / Twitter
    telegram: "https://t.me/...", // your Telegram
  },
  mintUrl: "",                  // NFT mint page (Crossmint / LaunchMyNFT)
  merchUrl: "",                 // merch store (Fourthwall / Shopify)
  gameUrl: "",                  // casino / burn-lottery dApp URL
  supabase: { url: "", anonKey: "", table: "allowlist" }, // allowlist storage
  waitlistEndpoint: "",         // optional fallback (Formspree/Getform)
};
```

Everything degrades gracefully when empty:
- `contractAddress` empty → shows "Coming soon", copy button disabled.
- `socials` empty → buttons show "Coming Soon" instead of linking.
- `mintUrl` / `merchUrl` empty → buttons show "Minting Soon" / "Store Opening Soon".
- `supabase` / `waitlistEndpoint` both empty → the allowlist form shows a
  friendly "opens soon" message.

Fill these in and the site lights up — no other code changes needed.

### Allowlist via Vercel Postgres (default — all first-party)

Signups (email + optional wallet) are stored in **your own Vercel Postgres**
database via a serverless function in this repo (`api/allowlist.js`). No
third-party form service, no wallet-collection ToS issues, and a real database
you can view and export.

**One-time setup:**
1. Vercel dashboard → your project → **Storage** → **Create Database** →
   **Postgres** → connect it to this project. This auto-injects the
   `POSTGRES_URL` env var.
2. **Redeploy** (Vercel does this automatically on the next push, or click
   Redeploy). The table is created on the first signup.

Until the database is connected, the function returns `503` and the form shows
a friendly "opens soon" message — so nothing looks broken pre-setup.

**View / export signups:** Vercel → **Storage** → your DB → **Data**, or run:
```sql
SELECT * FROM allowlist ORDER BY created_at DESC;
```
Export as CSV there for your mint/airdrop allowlist. Duplicate emails are
handled gracefully ("already on the list").

**Alternative backends** (only used if `apiEndpoint` is set to `""`):
- `CONFIG.supabase` — your own Supabase project (URL + anon key; enable RLS
  with an insert-only policy).
- `CONFIG.waitlistEndpoint` — a Formspree/Getform URL. ⚠️ Note: some form
  services (Formspree) prohibit collecting crypto wallet addresses, which is
  why the self-hosted Vercel function is the default.

### Trench Terminal (scanner + 1-tap trade)

`trench.html` — paste a Solana CA for an instant readout, then buy/sell in one tap.

- `lib/rpc.js` — shared server-side RPC helper.
- `api/bundle.js` — rug/bundle forensics: supply, holder concentration (real
  wallets only, curve excluded), launch snipers, shared-funder bundle clusters,
  and a 0–100 risk score. Best-effort; returns partial data, never hard-fails.
- `api/holders.js` — quick top-10/20 concentration. `api/curve.js` — pump
  bonding-curve % to graduation.
- `api/swap.js` — Jupiter quote+swap with a flat 1% **native platformFee** to
  `REFERRAL_ACCOUNT`; holders of `YOUR_TOKEN_MINT` get a discount (100k = half,
  1M = free). Falls back to a no-fee swap if the fee account isn't usable.
  Client signs single-signer (`signAndSendTransaction`).
- Price/liquidity/volume/mcap come from **DexScreener** client-side (no key).

### Env vars (Trench suite)

```
SOLANA_RPC            # your Helius/Alchemy/QuickNode key — server only, proxied
REFERRAL_ACCOUNT      # Jupiter referral wallet that collects the 1% fee
YOUR_TOKEN_MINT       # $CATBOY mint — holders get the fee discount
PRIVY_APP_ID          # seedless wallets (public, safe in client)
SETTLEMENT_SECRET_KEY # pays launcher 50% splits — settlement script ONLY, never on Vercel
DATABASE_URL          # Neon Postgres (already set) — launch registry
```

### Launchpad (non-custodial)

A thin, non-custodial layer over pump.fun infrastructure (BUILD SPEC).

- `api/solrpc.js` — secure RPC proxy. Set `SOLANA_RPC` (your Helius/Alchemy/
  QuickNode key) in Vercel env; the browser only calls `/api/solrpc` so the key
  never ships. **Do this first.**
- `api/launch.js` — 3 actions: `metadata` (→ pump.fun IPFS), `create`
  (→ PumpPortal `trade-local`, returns the serialized deploy tx + records the
  mint→dev_wallet mapping), `feed` (recent launches). Registry uses the existing
  Neon Postgres (`DATABASE_URL`).
- `launch.html` — in-browser deploy: the mint keypair is generated client-side
  and never leaves the browser; the deploy tx is multi-signer (mint keypair +
  user wallet via `signTransaction`, then self-submitted). Simulates before
  signing. Bring-your-own Phantom for now; seedless onboarding is a next phase.

**Env vars to set in Vercel:** `SOLANA_RPC` (required to enable deploys).
Until it's set, the RPC proxy returns 503 and the page shows a "not configured"
note.

**Not yet built (need keys + a non-Vercel host):**
- Trading terminal with Jupiter `platformFee` → referral account (the fee source).
- Settlement script (cron/Railway, holds `REFERRAL_ACCOUNT` + `SETTLEMENT_SECRET_KEY`)
  that pays each launcher their 50% off-chain. **Never deploy this on Vercel.**
- Seedless wallets (Phantom Connect / Privy).

**Design rules enforced:** non-custodial only; no approve/delegate/setAuthority;
no raw multi-recipient SOL transfers in user-signed txs (anti-Blowfish); fees via
Jupiter `platformFee`, single-recipient payments split off-chain.

### Pages

- `index.html` — home: hero, lore, journey, **art wall** (lightbox gallery),
  NFT teaser, tokenomics, roadmap, how to buy, merch teaser, FAQ, allowlist,
  socials. Intro splash video plays once per session (poster = welcome art).
- `nft.html` — full Genesis NFT collection: gallery (uses the key art),
  mint details, holder utility, how-to-mint.
- `merch.html` — full store: product grid, store button, shipping/payment info.
- `casino.html` — the **Burn Lottery**: enter with $CATBOY, winner takes the
  pot, losing entries are burned (deflationary). How-it-works + disclaimer.

All pages share `styles.css` + `script.js` and the same scroll-animation
engine (staggered reveals, parallax, progress bar, count-up stats).

Key art lives in `assets/art/`. Swap any file there to update both the art
wall and the NFT gallery.

### Replace the artwork

Drop your real logo/character image in at `assets/catboy.png` (square works
best — it's shown as a circle). The current file is a generated placeholder.

## Run locally

Just open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy

Any static host works — drag the folder into Netlify, Vercel, Cloudflare
Pages, or GitHub Pages.

---

*$CATBOY is a meme coin for entertainment and community. Not financial advice.*
