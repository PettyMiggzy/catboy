# CATBOY — To-Do / Backlog

Running list of parked work. Newest context at top of each section.

## Holder perks — remaining
- [ ] **City billboard (global display)** — the perks.html "claim billboard" currently
      saves text to localStorage only; it never shows in the 3D city and isn't shared.
      To finish: add a `billboards` table + `/api/billboard` (holder-gated claim + list),
      then render claimed billboards on the towers in `city.html` (three.js). Self-contained,
      ~1 hr. *(Done already: casino edge, fighter payout/caps + skin, merch discount,
      treasury vote, perks dashboard.)*
- [ ] **Holder discount on $CATBOY AI / PFP** — give NFT holders discounted (or a few free)
      AI generations and/or a cut on the PFP fee. Small change: reuse the on-chain holder
      check (DAS) in `bot/aigen.js` / `api/pfp.js`.

## $CATBOY AI bot — go-live (needs droplet access, after-work)
- [ ] Droplet `bot/.env`: set `AI_PROVIDER_KEY`, `AI_PROVIDER_BASE`, `AI_IMAGE_MODEL`,
      `AI_VIDEO_MODEL`, `AI_SECRET`, prices, then `git pull && pm2 restart catboy-buybot`.
- [ ] Vercel: `AI_SECRET` (match droplet), `AI_TREASURY`, `AI_DECIMALS=6`.
- [ ] Decide the `AI_TREASURY` wallet (fresh recommended) — public address only.
- [ ] Live end-to-end test: `/credits` → pay $CATBOY → `/img` in the group.
- [ ] **Monthly rebate payout** — cron/script to compute each holder's rebate (spend ×
      tier %, 0.5%/M up to 9M, 20% at 10M+), pay in $CATBOY, reset the month. (Phase 3.)
- [ ] **`/vid`** — flip `AI_ENABLE_VIDEO=true` once images are proven; consider running the
      long video job detached so it doesn't block command polling.

## Merch store — go-live
- [ ] Set `MERCH_TREASURY` + `PRINTFUL_API_KEY` in Vercel, fill real Printful variant ids
      in `api/merch.js` PRODUCTS (holder discount is already coded).
- [ ] Print-ready designs (Venice, anchored to the real Catboy).

## Future collections
- [ ] **Bobblehead superhero Catboy NFT collection** — high quality, all animated,
      original emblems (no real-brand logos = IP risk). Prototype when ready.

## Nice-to-haves
- [ ] Stake page: "tap a cat to select" hint (minor UX; tripped up first-time use).
- [ ] Rotate `WHALE_SECRET` (was pasted in chat during setup) — regenerate on droplet +
      update Vercel to match. Low priority (HMAC key, not a wallet).
