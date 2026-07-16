# WANTED: Outlaws of Sherwood — Handoff

Handoff for another Claude session to finish this NFT collection. Everything needed
to resume is in this folder. Secrets are NOT here (see "Secrets" below).

## What it is
A 20-piece **animated 1-of-1 NFT collection** for **$STAG / StagWifHood** on
**Robinhood Chain**, mirroring the existing **"The Hooded 20"** (20 animated 1/1
legends). Every piece is a **WANTED poster** — a hooded stag outlaw with a real
**$STAG bounty** the holder claims. King (the owner) wants **all 20 animated, zero
static**, then handed out to holders.

## Locked creative decisions (do not re-litigate)
- **Character style = The Hooded 20 look.** Detailed semi-realistic hooded stag,
  antlers, **glowing green eyes**, dark hood, **green crypto candlestick-chart
  background**, cinematic/premium, holding **ONE complete glowing green arrow**
  (shaft + green arrowhead + green fletching — a whale earlier flagged a missing
  shaft/tail, so keep the arrow whole). Reference image:
  `reference/hooded20_shadowrogue_ref.jpg` (Shadow Rogue, pulled from the Hooded 20
  promo). Anchor every Venice `image/edit` on this reference.
- **Poster style = classic Robin Hood / Sherwood.** Aged parchment, forest-green
  ornate border with crossed-arrows corners, arched mugshot, `WANTED / DEAD OR
  ALIVE`, name banner, crime, `REWARD X $STAG` (green), rarity badge, green wax
  seal, "BY ORDER OF THE SHERIFF OF NOTTINGHAM". Built by `scripts/posterlib.py`
  (`build(char_path, name, crime, reward, rarity, out, seed)`). NOT the light
  cartoon tan version (rejected), NOT flat meme-cartoon (rejected).
- **Whales are stag-ified but keep their signature look** (recognizable but
  cohesive). Do not put the raw human PFPs on the posters.

## Roster (20) + economics
Bounty = **real claimable $STAG**. Total **81,000 $STAG**, under King's 100k cap.

**6 whale 1/1s — MYTHIC, 6,000 $STAG each** (see `roster_whales.json`):
SPEX (weed-crown cyber king) · OLE MAN (jacked tattooed) · THE DUDE (Lebowski,
White Russian) · NACHO (grey hoodie/blue shades) · CRAIG MACK (gold pixel stag) ·
BLACK PUTIN (dark tribal).

**14 originals** (see `roster_originals.json`):
- LEGENDARY 5,000 ×4: Emerald Bandit, Shadowhoof, Green Ghost, Ironantler
- EPIC 3,000 ×5: Nightshade, Ember Fletcher, The Poacher, Coinreaver, Frostpoint
- RARE 2,000 ×5: Hedge Runner, Two-Bit Rogue, Bramble Scout, Copper Arrow, The Pickpocket

## Pipeline (per card)
1. **Character** — Venice `POST https://api.venice.ai/api/v1/image/edit`, model
   `nano-banana-pro-edit`, `image` = base64 of `reference/hooded20_shadowrogue_ref.jpg`,
   prompt = the STYLE preamble in `scripts/gen_originals.py` + the character `desc`
   from the roster. → character PNG.
2. **Animate** — Venice `video/queue` then poll `video/retrieve`, model
   `veo3.1-fast-image-to-video`, `duration:"4s"`, `resolution:"720p"`. Prompt =
   living-portrait loop (eyes pulse, arrow glows, candlesticks flicker, embers/rain,
   slow blink/head tilt; "NOT bouncy"). See `scripts/anim_batch.py`. → 4s mp4.
   NOTE: veo sometimes STALLS in PROCESSING (>30 min) — if so, re-queue that id.
3. **Compose** — `scripts/comp_anim.py` overpaints the animation into the poster's
   arched mugshot window (coords MX,MY,MW,MH,RAD in that file) → final card mp4.
   posterlib builds the static poster; comp_anim animates the window over it.

## Current state (what's done / left)
- ✅ **All 20 characters generated** → `characters/whale_*.jpg`, `characters/orig_*.jpg`
  (committed as JPEG q92; originals were PNG in the working dir).
- ✅ **4 whale cards fully animated + composed** → `cards/card_{spex,oleman,craigmack,blackputin}.mp4`.
- ⏳ **Dude + Nacho animations** — were stalling on veo; last action re-queued them.
  Re-run veo on `characters/whale_dude.jpg` and `whale_nacho.jpg`, then `comp_anim`.
- ⏳ **14 original animations** — characters ready, none animated yet. Run
  `anim_batch.py` over the 14, then `comp_anim.py` each.
- ⏳ **Metadata** — build 20 metadata JSONs: name, description, animation_url,
  attributes = [Reward, Rarity, Crime, Weapon, Poster Condition, Outlaw]. Not started.
- ⏳ **Contract** — `WantedBounty.sol` drafted, not deployed. Deploy with
  (STAG token, WANTED NFT addr, expiry); `setBounties(ids, amounts)`; `lock()`;
  fund with 81,000 $STAG; holders `claim(id)`.

## Key infra
- **Robinhood Chain** RPC `https://rpc.mainnet.chain.robinhood.com` (send header
  `User-Agent: Mozilla/5.0` or it 403s). Explorer `robinhoodchain.blockscout.com`.
- **$STAG** token `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` (18 decimals, 1B supply).
- **The Hooded 20** NFT `0x4384cB362D908d36266bDF3C31F18DB95EB127dc` (name "The Hooded 20").
- King's Telegram id `6820752140`. Bot `@STAGZBOT`.

## Secrets (NOT in this repo — ask King / re-provide)
- Venice API key (was at `/tmp/.vkey` in the build session) — needed for image/veo gen.
- STAGZBOT token (was `/tmp/.btoken`).
Never commit these.

## Notes / constraints
- This Claude only has GitHub access to `pettymiggzy/catboy` (NOT the stag repo).
  The live Hooded 20 art is hosted at stagwifhood.fun (paths have since moved; the
  reliable style ref is the committed `reference/hooded20_shadowrogue_ref.jpg`).
- King wants the final collection **hosted/handed out**, all animated. Deploy target
  is Robinhood Chain (same pattern as the Hooded Twenty contract).
- This branch (`claude/catboy-website-nspovy`) has Vercel auto-deploy disabled in
  `vercel.json`, so pushing here does not publish a site URL.
