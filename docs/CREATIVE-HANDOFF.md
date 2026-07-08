# $CATBOY — Creative & Ops Handoff (how to make art / NFTs / videos / stickers, and not blow the Vercel bill)

This is a self-contained brief so another session (or another dev) can produce the same
art, animated stickers, NFT assets, promos, and comics — and manage cost. No secrets are in
this file; the API keys live in the droplet `.env` / Vercel env / your password manager.

---

## 0. What powers the art (the one paid dependency)

Everything visual is generated through **Venice AI** (keep this private — never say "Venice"
in public marketing; call it "$CATBOY AI"). It's the ONLY thing that costs money per use.

- Base URL: `https://api.venice.ai/api/v1`
- Auth header: `Authorization: Bearer <YOUR_VENICE_KEY>` (the `VENICE_INFERENCE_KEY_…` — from
  your password manager / droplet `bot/.env` `AI_PROVIDER_KEY`).
- Shared balance: this one key funds ALL generation (stickers, promos, the AI bot). Watch it
  at venice.ai/settings/api → **API USD credits** (not "Pro"/Diem — those don't fund the API).
- In this cloud sandbox, outbound HTTPS goes through a proxy — add `--cacert /root/.ccr/ca-bundle.crt`
  to curl. On a normal machine you don't need that.

---

## 1. Generate an image (art)

`POST /api/v1/image/generate`
```json
{ "model": "nano-banana-pro", "prompt": "<prompt>", "width": 1024, "height": 1024,
  "format": "png", "return_binary": false }
```
Response: `{ "images": ["<base64 png>"] }` → base64-decode to a .png.

**Models / cost:**
- `nano-banana-pro` — **~$0.18**, best quality + best character consistency. Default.
- `grok-imagine-image-quality` — ~$0.08, cheaper, still good.
- `flux-2-pro` — alt option; supports `negative_prompt`, `seed`, `hide_watermark`.

**Techniques that matter:**
- **Character consistency:** lead every prompt with the SAME locked description:
  *"CATBOY, a cute stylized 3D animated movie character in Pixar/Arcane style, messy golden-blonde
  hair, blonde cat ears, glowing electric-blue eyes, black techwear jacket with cyan neon trim,
  silver Solana pendant…"* Then append the pose/action.
- **Two brand looks:** "chibi" (big head, cute) vs "regular/grown" (young-adult proportions,
  cool). The community prefers the **grown** one for stickers; chibi for cute reactions.
- **For anything you'll cut out (stickers/coins):** generate on `"…isolated on a solid flat
  pure white background, no border, no outline, no text, no words"`. White (or a green screen)
  mattes cleanly.

---

## 2. Animate an image → video (image-to-video)

Two-step queue + poll.

**Queue:** `POST /api/v1/video/queue`
```json
{ "model": "wan-2.6-flash-image-to-video", "prompt": "<motion prompt>",
  "image_url": "data:image/png;base64,<b64>", "duration": "5s", "resolution": "720p" }
```
→ `{ "queue_id": "…" }`

**Poll:** `POST /api/v1/video/retrieve` `{ "model": "<same>", "queue_id": "<id>" }`
- If the response `Content-Type` is `video/*` or `octet-stream` → the body IS the mp4, save it.
- Else it's JSON: `{ "status": "PROCESSING" }` (wait ~10s, retry) or has `download_url`.

**Models / cost:**
- `wan-2.6-flash-image-to-video` — **~$0.28**, cheaper, smaller files. Default.
- `kling-2.5-turbo-pro-image-to-video` — ~$0.44, higher quality.
- Rule of thumb: **1 image + 1 video ≈ $0.46 per animated asset.**

**Motion prompt tip:** describe subtle looping motion and *pin the background*: "…the solid
flat white background stays completely still, do not change the background."

---

## 3. Animated Telegram stickers (the full pipeline)

Per sticker: **gen (white bg) → animate → matte each frame → caption → encode webm.**

1. Generate the pose on a white background (§1).
2. Animate it (§2) → mp4.
3. Extract frames: `ffmpeg -t 3 -i anim.mp4 -vf "fps=30" fr/f_%03d.png`
4. Matte each frame to transparent with **rembg** (`pip install rembg`; `from rembg import remove,
   new_session; sess=new_session("u2net"); remove(img, session=sess)`). Fix a bounding box from
   frame 0 so the character doesn't jitter.
5. Caption + composite in PIL (fonts at `/mnt/skills/examples/canvas-design/canvas-fonts` —
   BigShoulders-Bold, BricolageGrotesque-Bold, GeistMono-Bold). No white "die-cut" outline —
   the community didn't like it.
6. Encode VP9 with alpha, ladder the CRF until ≤ 250 KB:
   `ffmpeg -framerate 30 -i of/o_%03d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 44 -an out.webm`

**Telegram specs (hard limits):**
- **Video sticker (.webm):** 512×512, ≤3 s, ≤30 fps, VP9, **≤256 KB**, transparent = `yuva420p`.
- **Custom emoji (.webm):** 100×100, ≤64 KB (e.g. the spinning coin).
- **.TGS (Lottie vector):** 60 fps, ≤64 KB — buttery, but **VECTOR ONLY** (flat shapes, CANNOT
  be 3D/detailed). Build by hand-authoring Lottie JSON then gzip → `.tgs` (no After Effects needed).
  Use only if you want a flat mascot; the 3D look must be `.webm`. In a chat nobody can tell the
  difference between .webm and .tgs.

**Publish the pack:** `scripts/publish_stickers.py` (Bot API — `uploadStickerFile` →
`createNewStickerSet` → `addStickerToSet`). Run with `TELEGRAM_BOT_TOKEN` + `STICKER_OWNER_ID`
(the owner must DM the bot once first). It prints the `t.me/addstickers/…` link.

---

## 4. Promos & comics (free-ish — reuse existing art)

- **Motion comic / promo video:** generate a few cinematic panels (§1, 16:9 e.g. 1280×768),
  animate (§2), then assemble with ffmpeg `zoompan` (Ken Burns push-in) + PIL text overlays
  (title cards, caption boxes, speech bubbles). See `scratchpad` build scripts as examples.
- **Static comic page:** lay panels into a grid in PIL with gutters, a title banner, yellow
  narration boxes, and white speech bubbles (draw the tail as a triangle). Export JPG or
  multi-page PDF (`img.save("out.pdf","PDF",save_all=True,append_images=[…])`).
- **A comic reads "longer" for free** via crops: close-ups + reaction panels + SFX from the same
  hero shots — you don't need new art for every panel.

---

## 5. NFT collections

- Layout: `assets/nft/<collection>/` with `img/`, `animated/`, `metadata/NNN.json`,
  `manifest.json`, `collection.json`. Metadata has `animation_url`, traits (Rarity/Energy/…).
- Mint model: **Metaplex Core, mint-on-demand** through `api/mint.js` (verifies payment on-chain,
  rolls the tier by pack odds, mints to the buyer). Each collection uses a separate DB id offset
  so primary keys never collide.
- **Deploy on-chain:** `scripts/create-collection.mjs` (needs a **funded mint-authority wallet** —
  the one thing that can't be done from a sandbox). Then set `NFT_COLLECTION_<NAME>` in Vercel +
  droplet and run `scripts/seed-inventory.mjs COLLECTION=<name>`.
- **DAS gotcha (bit us twice):** `getAssetsByOwner` takes **object** params
  `{ ownerAddress, page, limit }` — NOT an array-wrapped `[{…}]` (array → `invalid type: map`).

---

## 6. Don't rack up the Vercel bill

The $117 spike was **Build CPU Minutes**, not traffic. Root cause: **~233 commits/month, each
triggering a preview build** that clones the (365 MB) repo + runs `npm install`. Fixes:

1. **Already in `vercel.json`:** `git.deploymentEnabled` = false for the dev branch → no builds
   on dev pushes.
2. **In the Vercel dashboard:** Project → Settings → Git → turn **OFF Preview Deployments** for
   non-production branches. (Belt + suspenders.)
3. **Batch commits** — don't push every tiny change. Fewer pushes = fewer builds.
4. **Keep media OUT of git.** Big videos (`promo.mp4` had 7 versions ≈ 143 MB of history) bloat
   every clone. Host large media on the DO Spaces CDN you already run and reference the URL.
5. It's a static site + serverless functions — there's no real "build," so a build is just
   `npm install` + clone. Keep the repo lean and it stays a few dollars/month. (Or move hosting
   to **Cloudflare Pages** = $0, no per-build charge.)

---

## 7. Rules & gotchas (learned the hard way)

- **Never** paste a private key / seed phrase in chat. Generate wallets locally (browser console
  with `@solana/web3.js` `Keypair.generate()` prints address + base58 secret on YOUR machine).
- **Only share public wallet addresses.** Treasuries need only the public address in env.
- **Don't reveal the AI provider** publicly — env vars only; brand it "$CATBOY AI".
- **pm2:** for NEW env vars use `pm2 delete <name> && pm2 start …` — `pm2 restart` re-injects the
  stale env snapshot and your new vars won't load.
- **ESM env order:** each bot module loads its own `.env` synchronously at the top before reading
  `process.env`, because imports run before the entrypoint's `await loadEnv()`.
- **Shared Venice balance** funds all generation — check it before big batches (~$0.46/animated
  sticker, ~$2 for a promo, ~$5 for a 12-sticker pack).

---

## 8. Local tooling available in the cloud sandbox

- `ffmpeg` (static build, VP9/libvpx + libwebp; **no drawtext** — render text as PNG overlays).
- `rembg` (u2net) for background removal; `Pillow` + `numpy` for composition/typography.
- Chromium + global Playwright (for rendering Lottie/HTML to frames).
- Fonts: `/mnt/skills/examples/canvas-design/canvas-fonts/`.
