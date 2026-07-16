# WANTED: Outlaws of Sherwood — Handoff

A **21-piece animated 1-of-1 NFT collection** for **$STAG / StagWifHood** on
**Robinhood Chain**, in the spirit of "The Hooded 20". Every piece is a **WANTED
poster** with a real, claimable **$STAG bounty**. Secrets are NOT in this repo.

## STATUS: art + animation COMPLETE
- ✅ **21 unique characters** — `characters/` (7 `whale_*.jpg` + 14 `orig_*.jpg`)
- ✅ **21 WANTED posters** — `posters/*.jpg`
- ✅ **21 animated cards** — `cards/final_*.mp4` (each character animated into its poster)
- ✅ **21 metadata JSONs** — `metadata/1.json … 21.json`
- ✅ **Promo teaser** — `promo/wanted_promo.mp4`
- ✅ **Claim contract** — `WantedBounty.sol` (drafted, not deployed)
- ⏳ **Left to do:** deploy the NFT + `WantedBounty` contract on Robinhood Chain,
  pin art/metadata to IPFS (replace `ipfs://REPLACE/` in the metadata), fund the
  bounty contract with 87,000 $STAG, `setBounties()` + `lock()`, then hand out / mint.

## The 21 (economics: 87,000 $STAG total, under the 100k cap)
- **7 Mythic whales — 6,000 each** (`roster_whales.json`): SPEX, OLE MAN, THE DUDE,
  NACHO, CRAIG MACK, BLACK PUTIN, **MR T**. Real community members, stag-ified but
  keeping each one's signature look.
- **4 Legendary — 5,000:** Emerald Bandit, Shadowhoof, Green Ghost, Ironantler
- **5 Epic — 3,000:** Nightshade, Ember Fletcher, Poacher, Coinreaver, Frostpoint
- **5 Rare — 2,000:** Hedge Runner, Two-Bit Rogue, Bramble Scout, Copper Arrow, Pickpocket

tokenId order = the 7 whales (1–7) then the 14 originals (8–21); see `metadata/`.

## How the art was made (and the mistake to avoid)
- **Whales** (`characters/whale_*.jpg`): Venice `image/edit` (`nano-banana-pro-edit`)
  anchored on `reference/hooded20_shadowrogue_ref.jpg`, front-facing busts with each
  whale's signature (weed crown, gold pixel, lightning, etc.). Prompt in `scripts/gen_whales.py`.
- **Originals** (`characters/orig_*.jpg`): Venice **`image/generate`** (`seedream-v5-pro`),
  **text-to-image**, a UNIQUE pose/scene/palette/background per outlaw. Prompts in
  `scripts/gen_orig_unique.py`.
  ⚠️ **DO NOT regenerate the originals with `image/edit` off a single reference** — the
  first attempt did that and produced 14 near-identical "same body, different head"
  clones. Text-to-image with distinct per-character scene prompts is what makes them
  unique. Match `scripts/gen_orig_unique.py`.

## Pipeline
1. **Character** → see above (`scripts/gen_whales.py`, `scripts/gen_orig_unique.py`).
2. **Poster** → `scripts/posterlib2.py` `build(char, name, crime, reward, rarity, out, seed)`
   — classic Robin Hood parchment, square mugshot window (fits full scenes), name
   banner, crime, `REWARD X $STAG` (green), rarity badge, Sherwood seal.
3. **Animate** → Venice `video/queue`/`retrieve` (`veo3.1-fast-image-to-video`, 4s, 720p).
   Prompt = subtle living-scene loop (glowing eyes, per-scene particles, "NOT bouncy").
   NOTE: veo occasionally STALLS in PROCESSING >20 min — re-queue that id (it usually
   works on retry, as Dude/Nacho did).
4. **Compose** → `scripts/comp_anim2.py` overlays the animation into the poster's square
   window (WS=580, MX/MY in that file) → `cards/final_<name>.mp4`.

## Key infra
- Robinhood Chain RPC `https://rpc.mainnet.chain.robinhood.com` (needs
  `User-Agent: Mozilla/5.0`). Explorer `robinhoodchain.blockscout.com`.
- **$STAG** `0xCDdB2d9838b7eDab2F04aF4943a6EFE42C2f9F49` (18 dec, 1B supply).
- **The Hooded 20** NFT `0x4384cB362D908d36266bDF3C31F18DB95EB127dc`.
- Owner Telegram id `6820752140`, bot `@STAGZBOT`.

## Contract (`WantedBounty.sol`)
Deploy with (STAG token, WANTED NFT addr, expiry). `setBounties(ids, amounts)` from
`metadata/*` Reward values, `lock()`, fund with 87,000 $STAG. Holders `claim(id)`.

## Secrets (NOT committed — re-provide)
- Venice API key (was `/tmp/.vkey`) — needed for any regen/animation.
- STAGZBOT token (was `/tmp/.btoken`).

## Notes
- This session only has GitHub access to `pettymiggzy/catboy` (not the stag repo).
- Launch target: **Friday 7/17/26**, Robinhood Chain.
