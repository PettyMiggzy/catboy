#!/usr/bin/env python3
# Publish the $CATBOY animated sticker pack to Telegram via the Bot API.
#
# No @Stickers hand-dragging: this uploads each .webm and builds the pack for you.
#
# ONE-TIME SETUP:
#   1. The pack is OWNED by a real Telegram user. That user must have sent your
#      bot at least one message first (Telegram rule — bots can't create a pack
#      for a stranger). DM the bot "hi" from the owner account.
#   2. Get the owner's numeric user_id (message @userinfobot, or @getidsbot).
#
# RUN (nothing secret ever goes in a repo/chat — pass via env):
#   TELEGRAM_BOT_TOKEN=123:ABC  STICKER_OWNER_ID=987654321 \
#   PACK_NAME=catboy  PACK_TITLE="$CATBOY" \
#   STICKER_DIR=/path/to/webms  python3 scripts/publish_stickers.py
#
# PACK_NAME becomes  <PACK_NAME>_by_<botusername>  ->  t.me/addstickers/<that>
# Re-running with the same name ADDS any new stickers (skips existing set create).
import os, sys, json, glob, time, urllib.request, urllib.parse, mimetypes

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
OWNER = os.environ.get("STICKER_OWNER_ID", "").strip()
PACK  = os.environ.get("PACK_NAME", "catboy").strip()
TITLE = os.environ.get("PACK_TITLE", "$CATBOY").strip()
SDIR  = os.environ.get("STICKER_DIR", ".").strip()
API   = f"https://api.telegram.org/bot{TOKEN}"

if not TOKEN or not OWNER:
    sys.exit("Set TELEGRAM_BOT_TOKEN and STICKER_OWNER_ID (see header).")

# emoji per sticker basename (no extension). Unlisted files default to 🐾.
EMOJI = {
    "gm":"👋","gn":"😴","wagmi":"🤝","lfg":"🚀","hodl":"💎","moon":"🌙",
    "bullish":"📈","pumpit":"💪","rekt":"💀","fudoff":"🙄","apein":"🦍","mint":"🖼️",
    "ser":"🫵","wen":"🤷","based":"😎","kek":"😹","cope":"😭","sus":"🧐","alpha":"🤫",
    "o7":"🫡","rich":"🤑","sendit":"🚀","diamondhands":"💎","reborn":"🔥","ninelives":"🐾",
    "coin_spin":"🪙","coin_emoji":"🪙",
    "reg_lfg":"🚀","reg_bullish":"📈","reg_hodl":"💎","reg_wagmi":"🤝","reg_raid":"⚔️",
    "reg_rich":"🤑","reg_reborn":"🔥","reg_ninelives":"🐾","reg_nodm":"🚫","reg_noservice":"⛔","reg_buyabag":"💰",
}

def multipart(fields, files):
    boundary = "----catboy" + str(len(fields) + len(files))
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    for k, path in files.items():
        fn = os.path.basename(path); ct = mimetypes.guess_type(fn)[0] or "application/octet-stream"
        with open(path, "rb") as f: data = f.read()
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fn}\"\r\nContent-Type: {ct}\r\n\r\n".encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"

def call(method, fields=None, files=None):
    url = f"{API}/{method}"
    if files:
        body, ct = multipart(fields or {}, files)
        req = urllib.request.Request(url, data=body, headers={"Content-Type": ct})
    else:
        req = urllib.request.Request(url, data=urllib.parse.urlencode(fields or {}).encode())
    for attempt in range(4):
        try:
            j = json.load(urllib.request.urlopen(req, timeout=60))
            if not j.get("ok"): raise RuntimeError(j.get("description"))
            return j["result"]
        except Exception as e:
            if attempt == 3: raise
            time.sleep(2 * (attempt + 1))

me = call("getMe")
short = f"{PACK}_by_{me['username']}"
files = sorted(glob.glob(os.path.join(SDIR, "*.webm")))
if not files: sys.exit(f"No .webm files in {SDIR}")
print(f"Bot @{me['username']} — publishing {len(files)} stickers to t.me/addstickers/{short}")

# find existing set (to add rather than recreate)
existing = set()
try:
    s = call("getStickerSet", {"name": short})
    existing = {st["file_unique_id"] for st in s.get("stickers", [])}
    have_set = True
    print(f"  set exists with {len(existing)} stickers — adding new ones")
except Exception:
    have_set = False

def input_sticker(file_id, emoji):
    return {"sticker": file_id, "format": "video", "emoji_list": [emoji]}

uploaded = []
for path in files:
    base = os.path.splitext(os.path.basename(path))[0]
    emoji = EMOJI.get(base, "🐾")
    up = call("uploadStickerFile", {"user_id": OWNER, "sticker_format": "video"}, {"sticker": path})
    uploaded.append((up["file_id"], emoji, base))
    print(f"    uploaded {base} {emoji}")

if not have_set:
    first = uploaded[:1]
    call("createNewStickerSet", {
        "user_id": OWNER, "name": short, "title": TITLE,
        "stickers": json.dumps([input_sticker(fid, em) for fid, em, _ in first]),
    })
    print(f"  created set {short}")
    rest = uploaded[1:]
else:
    rest = uploaded

for fid, em, base in rest:
    try:
        call("addStickerToSet", {"user_id": OWNER, "name": short,
                                 "sticker": json.dumps(input_sticker(fid, em))})
        print(f"    added {base} {em}")
        time.sleep(0.5)
    except Exception as e:
        print(f"    skip {base}: {e}")

print(f"\n✅ DONE  ->  https://t.me/addstickers/{short}")
