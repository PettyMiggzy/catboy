# $STAG Animated Sticker Pipeline

How the `stagwifhood_by_STAGZBOT` Telegram sticker pack is made, so it doesn't need re-explaining.

**Pack:** https://t.me/addstickers/stagwifhood_by_STAGZBOT (34 stickers). Always **add to this existing
pack — never create a new link.**

## The style (locked)
- **Dark cinematic**, NOT flat cartoon. Reference confirmed by King: `hoodup.webm` (the hooded stag,
  dark room, moody lighting).
- **Transparent background**, animated (video/WEBM), looping.
- **Bright green label text** (`#9EF418`-ish) with a dark stroke + green glow, cream inner fill.
  Set in DejaVuSans-Bold. All-caps short phrases (e.g. "COOKIN'", "WAGMI", "DO YOU EVEN HODL").
- **No em dashes** anywhere in generated text (team preference).

## Pipeline (per sticker)
1. **Source still** `dk_<name>.png` — a dark-cinematic character frame (the stag doing the action).
2. **Animate** → Venice `POST /api/v1/video/queue`, model `veo3.1-full-image-to-video`,
   `image_url` = data URI of the still, `duration:"4s"`, a motion prompt (subtle bob / action, looping).
   Returns a `queue_id`. Poll `POST /api/v1/video/retrieve` `{queue_id, model}` — returns raw mp4 bytes
   when done, or JSON `{status:PROCESSING}` while rendering. **Queue jobs expire** if not pulled — retrieve
   promptly, and Venice must have credits or the queue silently fails.
3. **Label** `scripts/mklabel.py "<TEXT>" out.png` — renders the green glow/cream/stroke caption (512-wide).
4. **Encode** to Telegram video-sticker spec: **VP9 WEBM, 512×512, ≤3s, ≤256KB, no audio**, alpha via
   crop-to-square → scale 512 → overlay label → `libvpx-vp9`. Drop bitrate (300k→220k→160k) until ≤256KB.
5. **Publish** → `uploadStickerFile` (sticker_format=video) to get a `file_id`, then `addStickerToSet`
   with `name=stagwifhood_by_STAGZBOT` and the per-sticker `emoji_list`.

## Scripts
- `scripts/mklabel.py "<TEXT>" <out.png>` — the label renderer (the locked green style).
- `scripts/mkstk.py` — full-frame generator (rembg cutout + aura + label) for still-based packs.
- `scripts/publish.sh` — batch: waits for renders, encodes, adds each to the pack.
- `scripts/requeue4.sh` / `scripts/finish4b.sh` — re-queue + retrieve + publish a subset (used to finish
  the last 4). Note: queue body must be POSTed from a file/stdin (base64 image is too big for an inline
  `curl -d` arg → "Argument list too long"), and Venice now requires `duration`.

## Secrets (NOT committed — provide at runtime)
Scripts read these files: `/tmp/.btoken` (STAG_BOT_TOKEN), `/tmp/.bowner` (owner user id 6820752140),
`/tmp/.vkey` (Venice API key). Recreate them before running.

## Gotchas learned
- Preview on a dark page looked "non-transparent" — the stickers ARE transparent; it was the page bg.
- Cute/WEN cartoon style was wrong. Dark cinematic + bright green text is the one.
- Telegram clients **cache** sticker packs hard: after adding, re-open the addstickers link or restart the
  app to see new ones (this is why it can look like "only 30" when the server has 34).
